import type { CaptureBody, CaptureCookie } from '../api/client';
import type { ConnectionService } from '../connection/service';
import { t } from '../i18n';
import { CookieReader, fitCaptureLimits, type CookiesPort } from '../intercept/cookies';
import { downloadHost } from '../intercept/rules';
import type { Logger } from '../log/log';
import { redactUrl } from '../log/redact';
import { targetFor } from '../settings/routing';
import type { SecretStore, SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { canonicalUrl, classifyNetwork, type MediaKind } from './classify';
import { mediaFromPage, type PageMedia, type PageSnapshot } from './page';
import { parseDash, parseHls, type Variant } from './playlist';
import {
  addNetwork,
  emptyTab,
  limitTabs,
  MEDIA_TABS_KEY,
  parseTabs,
  replacePage,
  type MediaRow,
  type TabMedia,
} from './store';

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
  title: string;
  protectedMedia: boolean;
  blobOrMse: boolean;
  pageUrl: string;
}

export interface DownloadRequest {
  url: string;
  /** The page the media is on: its address, and the Referer the CDN may want. */
  pageUrl?: string | undefined;
  kind?: MediaKind | undefined;
  /** Chosen quality label, sent as the task's media hint. */
  quality?: string | undefined;
  /** `ytdlp` and `browser` download the page itself; `direct` (or nothing) downloads the media address. */
  resolverKind?: 'direct' | 'ytdlp' | 'browser' | undefined;
  /** The tab, to read the cookies of its cookie store. */
  tabId?: number | undefined;
  /** The tab is a private window. */
  incognito?: boolean | undefined;
  /** The file name to save as. It wins over the name the server gives. */
  name?: string | undefined;
  /** The address after redirects: what is downloaded. */
  finalUrl?: string | undefined;
  sizeBytes?: number | undefined;
  mime?: string | undefined;
  queueId?: string | undefined;
  paused?: boolean | undefined;
  /** Firefox: the container of the tab. */
  cookieStoreId?: string | undefined;
}

/** What a cookie request needs to know about the tab. */
export interface CookiesRequest {
  /** The address of the page: its host decides which cookies. */
  url: string;
  tabId?: number | undefined;
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
}

/** At most this many cookies of one site are sent (the daemon takes 200 in a capture; an import takes more). */
const MAX_SITE_COOKIES = 500;

interface Tasks {
  capture(body: CaptureBody): Promise<unknown>;
  listQueues(): Promise<{ id: string; name: string }[]>;
  importCookies(
    cookies: CaptureCookie[],
  ): Promise<{ imported: number; skipped: number; rejected: number }>;
  resolve(url: string): Promise<{ name: string; size: number; duplicate?: string }>;
}

export interface MediaDeps {
  secrets: Pick<SecretStore, 'get'>;
  settings: Pick<SettingsStore, 'get'>;
  connection: Pick<ConnectionService, 'get'> & {
    endpoint?(targetId: string): Promise<{ baseUrl: string; token: string } | undefined>;
    /** Paints the toolbar button of one tab with its media count. */
    paintTab?(tabId: number, count: number): Promise<void>;
  };
  session: KeyValueArea;
  log: Logger;
  tasks: (baseUrl: string, token: string) => Tasks;
  userAgent: string;
  /** Cookies for a media download. Absent in tests that do not send any. */
  cookies?: CookiesPort;
  /** Reads a playlist. The extension already has host access. */
  fetchText?: (url: string) => Promise<string>;
  now?: () => number;
}

/**
 * The per-tab media list. Network responses and the page scan both write it; the popup reads it. Nothing is kept in
 * memory: a restarted worker reads the same session storage, and every change is one read-modify-write in the storage
 * queue, so two responses arriving together cannot overwrite each other.
 */
export class MediaService {
  private readonly tabs: StoredValue<Record<string, TabMedia>>;
  private readonly cookieReader: CookieReader | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: MediaDeps) {
    this.tabs = new StoredValue(deps.session, MEDIA_TABS_KEY, parseTabs);
    this.cookieReader = deps.cookies ? new CookieReader(deps.cookies, deps.log) : undefined;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * A response of a tab. Classifying is pure and comes first, so the many responses that are not media (and the
   * segments of a stream, which are not listed) cost no storage access at all.
   */
  async observe(hit: {
    url: string;
    tabId: number;
    mime?: string;
    sizeBytes?: number;
  }): Promise<void> {
    if (hit.tabId < 0) return;
    const classified = classifyNetwork({
      url: hit.url,
      ...(hit.mime ? { mime: hit.mime } : {}),
      ...(hit.sizeBytes !== undefined ? { sizeBytes: hit.sizeBytes } : {}),
    });
    if (!classified || classified.manifestUrl) return;
    const row: MediaRow = {
      url: canonicalUrl(classified.url),
      kind: classified.kind,
      name: classified.name,
      source: 'network',
      ...(classified.mime ? { mime: classified.mime } : {}),
      ...(classified.sizeBytes !== undefined ? { sizeBytes: classified.sizeBytes } : {}),
    };
    const now = this.now();
    await this.change(hit.tabId, (tab) => addNetwork(tab, row, now));
  }

  /** The tab loads a new page: what was found on the old one is gone. */
  async navigated(tabId: number, pageUrl: string): Promise<void> {
    if (tabId < 0) return;
    const now = this.now();
    await this.change(tabId, () => emptyTab(pageUrl, now));
  }

  /** The tab is closed: forget its list. */
  async closed(tabId: number): Promise<void> {
    await this.tabs.update((all) => {
      const next = { ...all };
      delete next[String(tabId)];
      return next;
    });
  }

  /** An iframe of the tab plays protected media. */
  async markProtected(tabId: number): Promise<void> {
    const now = this.now();
    await this.change(tabId, (tab) => ({ ...tab, protectedMedia: true, at: now }));
  }

  /** The content script's scan of the top document of a tab. */
  async scan(tabId: number, snapshot: PageSnapshot): Promise<void> {
    const rows: MediaRow[] = mediaFromPage(snapshot).map((item) => pageRow(item));
    const now = this.now();
    await this.change(tabId, (tab) =>
      replacePage(
        tab,
        snapshot.pageUrl,
        rows,
        {
          protectedMedia: snapshot.protectedMedia,
          blobOrMse: snapshot.blobOrMse,
          title: snapshot.title,
        },
        now,
      ),
    );
  }

  async forTab(tabId: number): Promise<TabView> {
    const tab = (await this.tabs.get())[String(tabId)] ?? emptyTab();
    return {
      pageUrl: tab.pageUrl,
      title: tab.title,
      protectedMedia: tab.protectedMedia,
      blobOrMse: tab.blobOrMse,
      items: tab.items.map(viewOf),
    };
  }

  /** Qualities of a master playlist or MPD. A media playlist has none. */
  async variants(url: string): Promise<Variant[]> {
    if (!this.deps.fetchText) return [];
    try {
      const text = await this.deps.fetchText(url);
      return /\.mpd(\?|$)/i.test(url) || /<MPD[\s>]/i.test(text)
        ? parseDash(text, url)
        : parseHls(text, url);
    } catch (error) {
      this.deps.log.debug('media', 'playlist could not be read', { error, url: redactUrl(url) });
      return [];
    }
  }

  /**
   * Sends one item, a chosen variant, or the page itself through yt-dlp or the daemon's browser. It is a capture, like
   * an intercepted download: the page and the referrer, the cookies of this download's domain for this task only, and
   * the kind of stream, so a manifest without a `.m3u8` suffix is still recognised.
   */
  async download(request: DownloadRequest): Promise<{ ok: boolean; error?: string }> {
    const tasks = await this.client(request.url);
    if (!tasks) return { ok: false, error: t('links.offline') };
    try {
      await tasks.capture(await this.captureBody(request));
      return { ok: true };
    } catch (error) {
      this.deps.log.warn('media', 'could not send media', { error, url: redactUrl(request.url) });
      return { ok: false, error: t('intercept.reason.rejected') };
    }
  }

  private async captureBody(request: DownloadRequest): Promise<CaptureBody> {
    const body: CaptureBody = {
      url: request.url,
      cookieScope: 'task',
      userAgent: this.deps.userAgent,
    };
    if (request.pageUrl) {
      body.pageUrl = request.pageUrl;
      body.referrer = request.pageUrl;
    }
    if (request.name) body.name = request.name;
    if (request.finalUrl && request.finalUrl !== request.url) body.finalUrl = request.finalUrl;
    if (request.sizeBytes !== undefined) body.size = request.sizeBytes;
    if (request.mime) body.mime = request.mime;
    if (request.queueId) body.queueId = request.queueId;
    if (request.paused) body.paused = true;
    if (request.resolverKind === 'ytdlp' || request.resolverKind === 'browser') {
      body.resolverKind = request.resolverKind;
    } else if (request.kind) {
      // Whatever its name, an HLS or DASH address is a stream, and a chosen quality travels with it.
      body.mediaCandidates = [
        {
          url: request.url,
          kind: request.kind,
          ...(request.quality ? { variant: request.quality } : {}),
        },
      ];
    }
    // The cookies of the address that is downloaded: the real file after redirects, else the link.
    const cookieUrl = body.finalUrl ?? request.url;
    const host = downloadHost(cookieUrl);
    if (host && this.cookieReader) {
      const settings = await this.deps.settings.get();
      const cookies = await this.cookieReader.read({
        url: cookieUrl,
        pageUrl: request.pageUrl,
        storeId: request.cookieStoreId,
        tabId: request.tabId,
        incognito: request.incognito === true,
        allowPrivate: settings.rules.privateWindows,
        host,
      });
      const fitted = fitCaptureLimits(cookies);
      if (fitted.length > 0) body.cookies = fitted;
    }
    return body;
  }

  /** The queues of the DLM that downloads go to (the active target), for the picker. Empty when DLM cannot be reached. */
  async queues(): Promise<{ id: string; name: string }[]> {
    try {
      return (await (await this.client())?.listQueues()) ?? [];
    } catch (error) {
      this.deps.log.debug('media', 'queues could not be listed', { error });
      return [];
    }
  }

  /** The cookies the browser would send to this address (its host and parent domains), and for which site. */
  async siteCookies(request: CookiesRequest): Promise<{ host: string; cookies: CaptureCookie[] }> {
    const host = downloadHost(request.url);
    if (!host || !this.cookieReader) return { host: host ?? '', cookies: [] };
    const settings = await this.deps.settings.get();
    const cookies = await this.cookieReader.read({
      url: request.url,
      pageUrl: request.url,
      storeId: request.cookieStoreId,
      tabId: request.tabId,
      incognito: request.incognito === true,
      allowPrivate: settings.rules.privateWindows,
      host,
    });
    return { host, cookies: cookies.slice(0, MAX_SITE_COOKIES) };
  }

  /**
   * Gives DLM the cookies of one site, so that its downloads and its browser are signed in like this one. Called only
   * when the person asks (the panel shows how many and for which site first). DLM keeps them in its cookie store.
   */
  async sendSiteCookies(
    request: CookiesRequest,
  ): Promise<
    | { ok: true; host: string; imported: number; skipped: number; rejected: number }
    | { ok: false; error: string }
  > {
    const { host, cookies } = await this.siteCookies(request);
    if (cookies.length === 0) return { ok: false, error: t('cookies.none') };
    const tasks = await this.client(request.url);
    if (!tasks) return { ok: false, error: t('links.offline') };
    try {
      const result = await tasks.importCookies(cookies);
      this.deps.log.info('media', 'sent the cookies of a site', { host, count: cookies.length });
      return { ok: true, host, ...result };
    } catch (error) {
      this.deps.log.warn('media', 'could not send cookies', { error });
      return { ok: false, error: t('intercept.reason.rejected') };
    }
  }

  /** Lazy probes. One failure does not drop the others. */
  async probe(
    urls: readonly string[],
  ): Promise<{ url: string; name?: string; size?: number; duplicate?: string }[]> {
    const out: { url: string; name?: string; size?: number; duplicate?: string }[] = [];
    for (const url of urls.slice(0, 8)) {
      const tasks = await this.client(url);
      if (!tasks) continue;
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

  /** One read-modify-write of a tab's list, then its toolbar button. */
  private async change(tabId: number, fn: (tab: TabMedia) => TabMedia): Promise<void> {
    let count = 0;
    await this.tabs.update((all) => {
      const next = fn(all[String(tabId)] ?? emptyTab());
      count = next.items.length;
      return limitTabs({ ...all, [String(tabId)]: next });
    });
    await this.deps.connection.paintTab?.(tabId, count);
  }

  private async client(url?: string): Promise<Tasks | undefined> {
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
