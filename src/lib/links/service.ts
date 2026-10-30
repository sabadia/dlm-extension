import type { CaptureCookie } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import type { ConnectionService } from '../connection/service';
import { fileExtension, sanitizeFileName } from '../files/naming';
import { targetFor } from '../settings/routing';
import { chunk } from './filter';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import { redactUrl } from '../log/redact';
import type { SecretStore, SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { menuAction, menuTree, targetUrl, type MenuSpec, type QueueRef } from './menus';

/** The most bytes of a `.torrent` file the daemon accepts. */
export const TORRENT_LIMIT = 16 * 1024 * 1024;

export interface MenuClick {
  menuItemId: string;
  linkUrl?: string | undefined;
  srcUrl?: string | undefined;
  selectionText?: string | undefined;
  pageUrl?: string | undefined;
  checked?: boolean | undefined;
  tabId?: number | undefined;
  /** The title of the tab, to name the file after the page. */
  tabTitle?: string | undefined;
}

export interface MenuPort {
  removeAll(): Promise<void>;
  create(spec: MenuSpec): Promise<void> | void;
  /** Changes a checkbox that already exists. */
  update?(id: string, change: { checked: boolean }): Promise<void> | void;
  open(url: string): Promise<void>;
}

export interface TaskPort {
  listQueues(): Promise<{ queues: { id: string; name: string }[] | null }>;
  create(body: {
    url: string;
    queueId?: string;
    paused?: boolean;
    name?: string;
    checksum?: { algorithm: string; expected: string };
    mirrors?: string[];
  }): Promise<unknown>;
  createMany(
    items: { url: string; queueId?: string; paused?: boolean }[],
  ): Promise<{ ok: boolean }[]>;
  addTorrent(bytes: Uint8Array, query: { name?: string; paused?: boolean }): Promise<unknown>;
}

/** Reads a cookie-gated torrent the daemon could not fetch itself. */
export type FetchFile = (url: string) => Promise<Uint8Array>;

export interface LinksDeps {
  settings: Pick<SettingsStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get'> & {
    endpoint?(targetId: string): Promise<{ baseUrl: string; token: string } | undefined>;
  };
  session: KeyValueArea;
  log: Logger;
  menus: MenuPort;
  tasks: (baseUrl: string, token: string) => TaskPort;
  /** Tells the person something that happened to a menu click (a notification). Absent in tests that do not care. */
  notify?: (message: string) => void;
  /** Page that previews the links of a tab. */
  linksUrl: (tabId: number) => string;
  fetchFile?: FetchFile;
}

const PAUSED_KEY = 'links.paused';

/** The places with an "add paused" checkbox (`menus.ts`). */
const PAUSED_CONTEXTS = ['link', 'selection', 'image', 'audio', 'video', 'page'] as const;

function parsePaused(raw: unknown): boolean {
  return raw === true;
}

/**
 * Context menus, magnet and eD2K clicks, the "all links" batch, and cookie-gated torrent uploads. Queue names are read
 * when the menus are built; a click only needs the queue id stored in the menu id.
 */
export class LinksService {
  private readonly paused: StoredValue<boolean>;
  private building: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LinksDeps) {
    this.paused = new StoredValue(deps.session, PAUSED_KEY, parsePaused);
  }

  /**
   * Builds the menus. Safe to call again: it replaces whatever was there. Calls are queued, so two builds never run
   * their `removeAll` and `create` steps into each other. Called when the extension is installed or the browser starts,
   * and when DLM becomes reachable (the queues are listed then), not every time the background wakes.
   */
  install(): Promise<void> {
    const run = async (): Promise<void> => {
      const queues = await this.queues();
      const addPaused = await this.paused.get();
      await this.deps.menus.removeAll();
      for (const spec of menuTree(queues, addPaused)) await this.deps.menus.create(spec);
    };
    const result = this.building.then(run, run);
    this.building = result.catch((error: unknown) => {
      this.deps.log.warn('links', 'could not build the menus', { error });
    });
    return this.building;
  }

  /** A context-menu click. A failure is told to the person, not dropped. */
  async onClick(click: MenuClick): Promise<void> {
    try {
      await this.handleClick(click);
    } catch (error) {
      this.deps.log.warn('links', 'a menu action failed', { error });
      this.deps.notify?.(failureReason(error));
    }
  }

  private async handleClick(click: MenuClick): Promise<void> {
    const action = menuAction(String(click.menuItemId));
    if (!action) return;
    if (action.kind === 'paused') {
      const checked = click.checked === true;
      await this.paused.set(checked);
      // Every place has its own checkbox for the same setting: keep them in step.
      for (const context of PAUSED_CONTEXTS) {
        await this.deps.menus.update?.(`dlm:${context}:paused`, { checked });
      }
      return;
    }
    if (action.kind === 'all') {
      if (click.tabId === undefined) return;
      await this.deps.menus.open(this.deps.linksUrl(click.tabId));
      return;
    }
    const url = targetUrl(action.context, click);
    if (!url) return;
    const name = await this.titleName(url, click.tabTitle);
    await this.add(url, {
      queueId: action.queueId,
      paused: await this.paused.get(),
      ...(name ? { name } : {}),
    });
    this.deps.notify?.(t('links.sent', { ok: 1 }));
  }

  /** A magnet or eD2K link the content script caught. */
  addDirect(url: string): Promise<boolean> {
    return this.add(url, { paused: false }).then(
      () => true,
      () => false,
    );
  }

  /**
   * Sends the selected links. Returns how many were accepted. Stops at the daemon's batch size by sending several
   * batches.
   */
  async sendMany(urls: readonly string[]): Promise<{ ok: number; failed: number }> {
    if (this.deps.connection.endpoint) return this.sendRouted(urls);
    const tasks = await this.client();
    if (!tasks) return { ok: 0, failed: urls.length };
    const paused = await this.paused.get();
    let ok = 0;
    let failed = 0;
    for (const group of chunk(urls)) {
      try {
        const results = await tasks.createMany(group.map((url) => ({ url, paused })));
        for (const result of results) {
          if (result.ok) ok += 1;
          else failed += 1;
        }
      } catch (error) {
        this.deps.log.warn('links', 'batch failed', { error });
        failed += group.length;
      }
    }
    return { ok, failed };
  }

  /**
   * A `.torrent` download. With cookies, the bytes are uploaded (the daemon could not send those cookies for a bare
   * URL). Without cookies, the URL is enough.
   */
  private async sendRouted(urls: readonly string[]): Promise<{ ok: number; failed: number }> {
    const settings = await this.deps.settings.get();
    const groups = new Map<string, string[]>();
    for (const url of urls) {
      const targetId = targetFor(settings, url);
      groups.set(targetId, [...(groups.get(targetId) ?? []), url]);
    }
    const paused = await this.paused.get();
    let ok = 0;
    let failed = 0;
    for (const [targetId, group] of groups) {
      const endpoint = await this.deps.connection.endpoint?.(targetId);
      if (!endpoint) {
        failed += group.length;
        continue;
      }
      const tasks = this.deps.tasks(endpoint.baseUrl, endpoint.token);
      for (const batch of chunk(group)) {
        try {
          const results = await tasks.createMany(batch.map((url) => ({ url, paused })));
          for (const result of results) {
            if (result.ok) ok += 1;
            else failed += 1;
          }
        } catch (error) {
          this.deps.log.warn('links', 'batch failed', { error });
          failed += batch.length;
        }
      }
    }
    return { ok, failed };
  }

  async addTorrent(facts: {
    url: string;
    filename?: string;
    cookies?: CaptureCookie[];
  }): Promise<'taken' | 'duplicate' | 'failed'> {
    const tasks = await this.client(facts.url);
    if (!tasks) return 'failed';
    const paused = await this.paused.get();
    try {
      if (facts.cookies && facts.cookies.length > 0 && this.deps.fetchFile) {
        const bytes = await this.deps.fetchFile(facts.url);
        if (bytes.byteLength > TORRENT_LIMIT) return 'failed';
        await tasks.addTorrent(bytes, {
          ...(facts.filename ? { name: facts.filename } : {}),
          paused,
        });
      } else {
        await tasks.create({
          url: facts.url,
          paused,
          ...(facts.filename ? { name: facts.filename } : {}),
        });
      }
      return 'taken';
    } catch (error) {
      // DLM already has it: not a failure, and not a reason to download the file in the browser.
      if (error instanceof ApiError && error.status === 409) return 'duplicate';
      this.deps.log.warn('links', 'torrent was not accepted', { error, url: redactUrl(facts.url) });
      return 'failed';
    }
  }

  /** The page title and the link's extension, when the settings name files after the page and the link has an extension. */
  private async titleName(url: string, title: string | undefined): Promise<string | undefined> {
    if (!title || !/^https?:/i.test(url)) return undefined;
    if ((await this.deps.settings.get()).files.naming !== 'title') return undefined;
    const stem = sanitizeFileName(title);
    const ext = fileExtension({ url });
    return stem && ext ? `${stem}.${ext}` : undefined;
  }

  private async add(
    url: string,
    options: { queueId?: string; paused: boolean; name?: string },
  ): Promise<void> {
    const tasks = await this.client(url);
    if (!tasks) throw new Error(t('links.offline'));
    let queueId = options.queueId;
    if (this.deps.connection.endpoint) {
      const settings = await this.deps.settings.get();
      if (targetFor(settings, url) !== settings.activeTargetId) queueId = undefined;
    }
    // A checksum or mirror list a page printed is reviewed before it is sent (the ask page, when a download is
    // intercepted); a link the person chose from a menu or the links page is sent as it is.
    await tasks.create({
      url,
      paused: options.paused,
      ...(queueId ? { queueId } : {}),
      ...(options.name ? { name: options.name } : {}),
    });
    this.deps.log.info('links', 'sent a link', { url: redactUrl(url) });
  }

  private async queues(): Promise<QueueRef[]> {
    try {
      const tasks = await this.client();
      const list = tasks ? await tasks.listQueues() : { queues: null };
      return (list.queues ?? []).map((queue) => ({ id: queue.id, name: queue.name }));
    } catch (error) {
      this.deps.log.debug('links', 'queues could not be listed', { error });
      return [];
    }
  }

  private async client(url?: string): Promise<TaskPort | undefined> {
    if (url && this.deps.connection.endpoint) {
      const settings = await this.deps.settings.get();
      const endpoint = await this.deps.connection.endpoint(targetFor(settings, url));
      if (!endpoint) return undefined;
      return this.deps.tasks(endpoint.baseUrl, endpoint.token);
    }
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') return undefined;
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) return undefined;
    return this.deps.tasks(state.baseUrl, token);
  }
}

export function failureReason(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  return t('links.offline');
}
