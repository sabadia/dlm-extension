import type { ConnectionService } from '../connection/service';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import { redactUrl } from '../log/redact';
import type { SecretStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { parseHandoffCount } from '../intercept/count';
import { classifyNetwork, type MediaKind } from './classify';
import { parseDash, parseHls, type Variant } from './playlist';
import type { PageMedia, PageSnapshot } from './page';
import { mediaFromPage } from './page';
import {
  addNetwork,
  parseTab,
  replacePage,
  visibleItems,
  type MediaRow,
  type TabMedia,
} from './store';

/** The badge number for the tab the person is looking at. */
export const MEDIA_BADGE_KEY = 'media.badge';

const MAX_TABS = 30;

export interface MediaView {
  url: string;
  kind: MediaKind;
  name: string;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  duplicate?: string | undefined;
}

export interface TabView {
  items: MediaView[];
  protectedMedia: boolean;
  blobOrMse: boolean;
  pageUrl: string;
}

export interface DownloadRequest {
  url: string;
  pageUrl?: string | undefined;
  kind?: MediaKind | undefined;
  /** Chosen quality label, sent as the task's media hint. */
  quality?: string | undefined;
  resolverKind?: 'direct' | 'ytdlp' | 'browser' | undefined;
}

interface Tasks {
  create(body: {
    url?: string;
    source?: {
      currentUrl: string;
      resolverKind?: 'ytdlp' | 'browser';
      mediaHint?: string;
      pageUrl?: string;
      streamKind?: 'hls' | 'dash';
    };
  }): Promise<unknown>;
  resolve(url: string): Promise<{ name: string; size: number; duplicate?: string }>;
}

export interface MediaDeps {
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get' | 'repaint'>;
  session: KeyValueArea;
  log: Logger;
  tasks: (baseUrl: string, token: string) => Tasks;
  /** Reads a playlist. The extension already has host access. */
  fetchText?: (url: string) => Promise<string>;
}

/**
 * The per-tab media list. Network responses and the page scan both write it; the popup reads it. Nothing is kept in
 * memory: a restarted worker reads the same session storage.
 */
export class MediaService {
  private readonly tabs: StoredValue<Record<string, TabMedia>>;

  constructor(private readonly deps: MediaDeps) {
    this.tabs = new StoredValue(deps.session, 'media.tabs', parseTabs);
  }

  /** A response the classifier accepts. `pageUrl` is the tab's document, when webRequest knows it. */
  async observe(hit: {
    url: string;
    tabId: number;
    mime?: string;
    sizeBytes?: number;
    pageUrl?: string;
  }): Promise<void> {
    if (hit.tabId < 0) return;
    const tab = await this.read(hit.tabId);
    const manifests = tab.items
      .filter((item) => item.kind === 'hls' || item.kind === 'dash')
      .map((item) => item.url);
    const classified = classifyNetwork({
      url: hit.url,
      ...(hit.mime ? { mime: hit.mime } : {}),
      ...(hit.sizeBytes !== undefined ? { sizeBytes: hit.sizeBytes } : {}),
      manifests,
    });
    if (!classified) return;
    const row: MediaRow = {
      url: classified.url,
      kind: classified.kind,
      name: classified.name,
      source: 'network',
      ...(classified.mime ? { mime: classified.mime } : {}),
      ...(classified.sizeBytes !== undefined ? { sizeBytes: classified.sizeBytes } : {}),
      ...(classified.manifestUrl ? { manifestUrl: classified.manifestUrl } : {}),
    };
    await this.write(hit.tabId, addNetwork(tab, row, hit.pageUrl ?? tab.pageUrl));
  }

  /** The content script's scan of the document the person is looking at. */
  async scan(tabId: number, snapshot: PageSnapshot, visible: boolean): Promise<void> {
    const tab = await this.read(tabId);
    const rows: MediaRow[] = mediaFromPage(snapshot).map((item) => pageRow(item));
    const next = replacePage(tab, snapshot.pageUrl, rows, {
      protectedMedia: snapshot.protectedMedia,
      blobOrMse: snapshot.blobOrMse,
    });
    await this.write(tabId, next);
    if (visible) await this.paint(visibleItems(next).length);
  }

  async forTab(tabId: number): Promise<TabView> {
    const tab = await this.read(tabId);
    return {
      pageUrl: tab.pageUrl,
      protectedMedia: tab.protectedMedia,
      blobOrMse: tab.blobOrMse,
      items: visibleItems(tab).map(viewOf),
    };
  }

  /** Qualities of a master playlist or MPD. A media playlist has none. */
  async variants(url: string): Promise<Variant[]> {
    if (!this.deps.fetchText) return [];
    try {
      const text = await this.deps.fetchText(url);
      return url.toLowerCase().includes('.mpd') ? parseDash(text, url) : parseHls(text, url);
    } catch (error) {
      this.deps.log.debug('media', 'playlist could not be read', { error, url: redactUrl(url) });
      return [];
    }
  }

  /** Sends one item, a chosen variant, or the page itself through yt-dlp or the daemon's browser. */
  async download(request: DownloadRequest): Promise<{ ok: boolean; error?: string }> {
    const tasks = await this.client();
    if (!tasks) return { ok: false, error: t('links.offline') };
    try {
      if (
        request.resolverKind === 'ytdlp' ||
        request.resolverKind === 'browser' ||
        request.quality
      ) {
        await tasks.create({
          source: {
            currentUrl: request.url,
            ...(request.resolverKind === 'ytdlp' || request.resolverKind === 'browser'
              ? { resolverKind: request.resolverKind }
              : {}),
            ...(request.quality ? { mediaHint: request.quality } : {}),
            ...(request.pageUrl ? { pageUrl: request.pageUrl } : {}),
            ...(request.kind === 'hls' ? { streamKind: 'hls' as const } : {}),
            ...(request.kind === 'dash' ? { streamKind: 'dash' as const } : {}),
          },
        });
      } else {
        await tasks.create({ url: request.url });
      }
      return { ok: true };
    } catch (error) {
      this.deps.log.warn('media', 'could not send media', { error, url: redactUrl(request.url) });
      return { ok: false, error: t('intercept.reason.rejected') };
    }
  }

  /** Lazy probes. One failure does not drop the others. */
  async probe(
    urls: readonly string[],
  ): Promise<{ url: string; name?: string; size?: number; duplicate?: string }[]> {
    const tasks = await this.client();
    if (!tasks) return [];
    const out: { url: string; name?: string; size?: number; duplicate?: string }[] = [];
    for (const url of urls.slice(0, 8)) {
      try {
        const result = await tasks.resolve(url);
        out.push({
          url,
          name: result.name,
          size: result.size,
          ...(result.duplicate ? { duplicate: result.duplicate } : {}),
        });
      } catch (error) {
        this.deps.log.debug('media', 'probe failed', { error, url: redactUrl(url) });
      }
    }
    return out;
  }

  private async read(tabId: number): Promise<TabMedia> {
    const all = await this.tabs.get();
    return (
      all[String(tabId)] ?? { pageUrl: '', protectedMedia: false, blobOrMse: false, items: [] }
    );
  }

  private async write(tabId: number, tab: TabMedia): Promise<void> {
    await this.tabs.update((all) => {
      const next = { ...all, [String(tabId)]: tab };
      const ids = Object.keys(next);
      if (ids.length <= MAX_TABS) return next;
      delete next[ids[0] ?? ''];
      return next;
    });
  }

  private async paint(count: number): Promise<void> {
    await this.deps.session.set(MEDIA_BADGE_KEY, count);
    await this.deps.connection.repaint();
  }

  private async client(): Promise<Tasks | undefined> {
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') return undefined;
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) return undefined;
    return this.deps.tasks(state.baseUrl, token);
  }
}

function pageRow(item: PageMedia): MediaRow {
  return {
    url: item.url,
    kind: item.kind,
    name: item.name,
    source: 'page',
    ...(item.mime ? { mime: item.mime } : {}),
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
  };
}

function viewOf(row: MediaRow): MediaView {
  return {
    url: row.url,
    kind: row.kind,
    name: row.name,
    ...(row.mime ? { mime: row.mime } : {}),
    ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
  };
}

function parseTabs(raw: unknown): Record<string, TabMedia> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, TabMedia> = {};
  for (const [id, value] of Object.entries(raw)) out[id] = parseTab(value);
  return out;
}

export function mediaBadgeCount(raw: unknown): number {
  return parseHandoffCount(raw);
}
