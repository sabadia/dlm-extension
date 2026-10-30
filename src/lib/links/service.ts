import type { CaptureCookie } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import type { ConnectionService } from '../connection/service';
import type { HintStore } from '../page/store';
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
}

export interface MenuPort {
  removeAll(): Promise<void>;
  create(spec: MenuSpec): Promise<void> | void;
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
  hints?: Pick<HintStore, 'find'>;
  session: KeyValueArea;
  log: Logger;
  menus: MenuPort;
  tasks: (baseUrl: string, token: string) => TaskPort;
  /** Page that previews the links of a tab. */
  linksUrl: (tabId: number) => string;
  fetchFile?: FetchFile;
}

const PAUSED_KEY = 'links.paused';

function parsePaused(raw: unknown): boolean {
  return raw === true;
}

/**
 * Context menus, magnet and eD2K clicks, the "all links" batch, and cookie-gated torrent uploads. Queue names are read
 * when the menus are built; a click only needs the queue id stored in the menu id.
 */
export class LinksService {
  private readonly paused: StoredValue<boolean>;

  constructor(private readonly deps: LinksDeps) {
    this.paused = new StoredValue(deps.session, PAUSED_KEY, parsePaused);
  }

  /** Builds the menus. Safe to call again: it replaces whatever was there. */
  async install(): Promise<void> {
    const queues = await this.queues();
    const addPaused = await this.paused.get();
    await this.deps.menus.removeAll();
    for (const spec of menuTree(queues, addPaused)) await this.deps.menus.create(spec);
  }

  /** A context-menu click. */
  async onClick(click: MenuClick): Promise<void> {
    const action = menuAction(String(click.menuItemId));
    if (!action) return;
    if (action.kind === 'paused') {
      await this.paused.set(click.checked === true);
      return;
    }
    if (action.kind === 'all') {
      if (click.tabId === undefined) return;
      await this.deps.menus.open(this.deps.linksUrl(click.tabId));
      return;
    }
    const url = targetUrl(action.context, click);
    if (!url) return;
    await this.add(url, { queueId: action.queueId, paused: await this.paused.get() });
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
  }): Promise<'taken' | 'failed'> {
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
      this.deps.log.warn('links', 'torrent was not accepted', { error, url: redactUrl(facts.url) });
      return 'failed';
    }
  }

  private async add(url: string, options: { queueId?: string; paused: boolean }): Promise<void> {
    const tasks = await this.client(url);
    if (!tasks) throw new Error(t('links.offline'));
    let queueId = options.queueId;
    let checksum: { algorithm: string; expected: string } | undefined;
    let mirrors: string[] | undefined;
    if (this.deps.connection.endpoint || this.deps.hints) {
      const settings = await this.deps.settings.get();
      if (this.deps.connection.endpoint && targetFor(settings, url) !== settings.activeTargetId) {
        queueId = undefined;
      }
      const hint = await this.deps.hints?.find([url]);
      if (hint?.checksum) checksum = hint.checksum;
      if (settings.preferences.mirrors && hint?.mirrors && hint.mirrors.length > 0) {
        mirrors = hint.mirrors;
      }
    }
    await tasks.create({
      url,
      paused: options.paused,
      ...(queueId ? { queueId } : {}),
      ...(checksum ? { checksum } : {}),
      ...(mirrors ? { mirrors } : {}),
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
