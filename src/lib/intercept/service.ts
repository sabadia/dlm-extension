import type { CaptureBody, CaptureCookie } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import type { ConnectionService } from '../connection/service';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import { redactUrl } from '../log/redact';
import type { SecretStore, SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { HANDOFF_COUNT_KEY, parseHandoffCount } from './count';
import {
  basename,
  buildCaptureBody,
  contentLength,
  displayName,
  filenameFromDisposition,
  headerValue,
  isAttachment,
  pickRequestHeaders,
  toCaptureCookie,
  type BrowserCookieLike,
  type CaptureDraft,
  type RawHeader,
} from './metadata';
import {
  matchObservation,
  mergeObservation,
  readGesture,
  rememberGesture,
  rememberObservation,
  type Gesture,
  type Observation,
} from './observations';
import { isTorrent } from '../links/classify';
import { decide, downloadHost, type DownloadFacts } from './rules';

/** A browser download, reduced to what the hand-off reads. */
export interface DownloadSnapshot {
  id: number;
  url: string;
  finalUrl?: string | undefined;
  referrer?: string | undefined;
  filename?: string | undefined;
  mime?: string | undefined;
  /** Absent when the browser does not know yet (`fileSize` of -1). */
  sizeBytes?: number | undefined;
  incognito: boolean;
  byExtensionId?: string | undefined;
}

/** The part of a `webRequest` event the cache keeps. */
export interface RequestEvent {
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  documentUrl?: string | undefined;
  initiator?: string | undefined;
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
  requestHeaders?: RawHeader[] | undefined;
  responseHeaders?: RawHeader[] | undefined;
}

export interface DownloadsPort {
  cancel(id: number): Promise<void>;
  erase(query: { id: number }): Promise<number[]>;
  download(options: { url: string; filename?: string | undefined }): Promise<number>;
}

export interface CookieQuery {
  url: string;
  storeId?: string | undefined;
  partitionKey?: { topLevelSite: string } | undefined;
}

export interface CookiesPort {
  getAll(query: CookieQuery): Promise<BrowserCookieLike[]>;
}

export interface NotificationsPort {
  create(
    id: string,
    options: { title: string; message: string; iconUrl?: string | undefined },
  ): Promise<string> | void;
}

export interface WindowsPort {
  create(info: {
    url: string;
    type: 'popup';
    width: number;
    height: number;
  }): Promise<{ id?: number | undefined }>;
}

/** What one capture call returns. Tests pass a fake; the real one is {@link DlmClient.capture}. */
export interface CaptureClient {
  capture(body: CaptureBody): Promise<unknown>;
}

export type AskChoice = 'dlm' | 'browser' | 'always';

export interface PendingAsk {
  id: string;
  host: string;
  name: string;
  fallbackUrl: string;
  filename?: string | undefined;
  body: CaptureBody;
  windowId?: number | undefined;
  resolved: boolean;
  at: number;
}

/** `working` is in progress, `taken` reached DLM, `failed` left the file with the browser. */
type ClaimResult = 'working' | 'taken' | 'failed';

interface Claim {
  url: string;
  at: number;
  result: ClaimResult;
}

const CLAIM_TTL_MS = 60_000;
const ASK_TTL_MS = 2 * 60_000;
const OBSERVED_KEY = 'intercept.observed';
const GESTURE_KEY = 'intercept.gestures';
const RELEASED_KEY = 'intercept.released';
const CLAIM_KEY = 'intercept.claims';
const ASK_KEY = 'intercept.asks';

const parseList =
  <T>(item: (raw: unknown) => T | undefined) =>
  (raw: unknown): T[] =>
    Array.isArray(raw)
      ? raw.flatMap((value) => {
          const parsed = item(value);
          return parsed === undefined ? [] : [parsed];
        })
      : [];

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function parseObservation(raw: unknown): Observation | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.requestId !== 'string' || typeof record.url !== 'string')
    return undefined;
  if (
    typeof record.method !== 'string' ||
    typeof record.tabId !== 'number' ||
    typeof record.at !== 'number'
  )
    return undefined;
  const headers = asRecord(record.requestHeaders);
  const requestHeaders: Record<string, string> = {};
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') requestHeaders[key] = value;
    }
  }
  return {
    requestId: record.requestId,
    url: record.url,
    method: record.method,
    tabId: record.tabId,
    requestHeaders,
    incognito: record.incognito === true,
    attachment: record.attachment === true,
    at: record.at,
    ...(typeof record.finalUrl === 'string' ? { finalUrl: record.finalUrl } : {}),
    ...(typeof record.documentUrl === 'string' ? { documentUrl: record.documentUrl } : {}),
    ...(typeof record.initiator === 'string' ? { initiator: record.initiator } : {}),
    ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
    ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    ...(typeof record.userAgent === 'string' ? { userAgent: record.userAgent } : {}),
    ...(typeof record.cookieStoreId === 'string' ? { cookieStoreId: record.cookieStoreId } : {}),
  };
}

function parseGestureMap(raw: unknown): Record<string, Gesture> {
  const record = asRecord(raw);
  if (!record) return {};
  const map: Record<string, Gesture> = {};
  for (const [id, value] of Object.entries(record)) {
    const gesture = asRecord(value);
    if (!gesture || typeof gesture.at !== 'number') continue;
    map[id] = { alt: gesture.alt === true, shift: gesture.shift === true, at: gesture.at };
  }
  return map;
}

function claimResult(value: unknown): ClaimResult {
  if (value === 'taken' || value === 'failed') return value;
  return 'working';
}

function parseStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function parseClaims(raw: unknown): Claim[] {
  return parseList((value) => {
    const record = asRecord(value);
    if (!record || typeof record.url !== 'string' || typeof record.at !== 'number')
      return undefined;
    return { url: record.url, at: record.at, result: claimResult(record.result) };
  })(raw);
}

function parseAsks(raw: unknown): PendingAsk[] {
  return parseList((value) => {
    const record = asRecord(value);
    if (!record || typeof record.id !== 'string' || typeof record.host !== 'string')
      return undefined;
    if (
      typeof record.name !== 'string' ||
      typeof record.fallbackUrl !== 'string' ||
      typeof record.at !== 'number'
    )
      return undefined;
    const body = asRecord(record.body);
    if (!body || typeof body.url !== 'string') return undefined;
    return {
      id: record.id,
      host: record.host,
      name: record.name,
      fallbackUrl: record.fallbackUrl,
      body: body as unknown as CaptureBody,
      resolved: record.resolved === true,
      at: record.at,
      ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
      ...(typeof record.windowId === 'number' ? { windowId: record.windowId } : {}),
    };
  })(raw);
}

export interface InterceptDeps {
  settings: Pick<SettingsStore, 'get' | 'update'>;
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get' | 'repaint'>;
  session: KeyValueArea;
  log: Logger;
  /** This extension's id, compared with `byExtensionId`. */
  extensionId: string;
  /** `chrome-extension://<id>` or `moz-extension://<uuid>`, so a request we started is left alone. */
  extensionOrigin: string;
  userAgent: string;
  /** Firefox may cancel an attachment in `webRequest` before a download exists. */
  firefox: boolean;
  /** Icon shown on a notification. Omitted when the extension has none. */
  iconUrl?: string | undefined;
  downloads: DownloadsPort;
  cookies: CookiesPort;
  notifications: NotificationsPort;
  windows: WindowsPort;
  /** Address of the ask page for one pending id. */
  askUrl: (id: string) => string;
  client: (baseUrl: string, token: string) => CaptureClient;
  /**
   * Sends a `.torrent` by URL, or as bytes when the download carried cookies. Absent in tests that are not about
   * torrents; those downloads are captured like any other file.
   */
  torrents?: {
    addTorrent(facts: {
      url: string;
      filename?: string | undefined;
      cookies?: CaptureBody['cookies'];
    }): Promise<'taken' | 'failed'>;
  };
  now?: () => number;
  id?: () => string;
}

type SendResult = 'taken' | 'duplicate' | 'failed';

/**
 * Hands browser downloads to DLM. Listeners are registered by {@link registerBackground} while the background loads;
 * everything they need is read from storage when the event arrives, so a worker that stopped in between still behaves.
 */
export class InterceptService {
  private readonly observed: StoredValue<Observation[]>;
  private readonly gestures: StoredValue<Record<string, Gesture>>;
  private readonly released: StoredValue<string[]>;
  private readonly claims: StoredValue<Claim[]>;
  private readonly asks: StoredValue<PendingAsk[]>;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: InterceptDeps) {
    this.observed = new StoredValue(deps.session, OBSERVED_KEY, parseList(parseObservation));
    this.gestures = new StoredValue(deps.session, GESTURE_KEY, parseGestureMap);
    this.released = new StoredValue(deps.session, RELEASED_KEY, parseStrings);
    this.claims = new StoredValue(deps.session, CLAIM_KEY, parseClaims);
    this.asks = new StoredValue(deps.session, ASK_KEY, parseAsks);
    this.now = deps.now ?? (() => Date.now());
    this.id = deps.id ?? (() => crypto.randomUUID());
  }

  /** A content script saw Alt or Shift. The tab id comes from the sender, not from the page. */
  noteGesture(tabId: number, alt: boolean, shift: boolean): Promise<void> {
    const now = this.now();
    return this.gestures
      .update((map) => rememberGesture(map, tabId, alt, shift, now))
      .then(() => undefined);
  }

  /** Request headers, cached until the download item exists. */
  onBeforeSendHeaders(event: RequestEvent): Promise<void> {
    return this.remember(event, false);
  }

  /**
   * Response headers. On Firefox an attachment that the rules take is captured here and the request is cancelled, so
   * no download entry appears (spike E0.7). Anywhere else this only fills the cache.
   */
  async onHeadersReceived(event: RequestEvent): Promise<{ cancel: true } | void> {
    await this.remember(event, true);
    if (!this.deps.firefox) return;
    const observed = await this.observed.get();
    const current = observed.find((item) => item.requestId === event.requestId);
    if (!current?.attachment) return;
    if (this.ownRequest(current)) return;
    const prepared = await this.prepare(current);
    if (!prepared || prepared.decision.action !== 'take') return;
    const address = prepared.draft.finalUrl ?? prepared.draft.url;
    if ((await this.claim(address)) !== 'won') return;
    const result = await this.deliver(prepared.draft, prepared.name);
    await this.settle(address, result === 'failed' ? 'failed' : 'taken');
    if (result === 'failed') return;
    return { cancel: true };
  }

  /** The common path (spike E0.7): cancel and erase, then hand the download to DLM. */
  async onCreated(item: DownloadSnapshot): Promise<void> {
    const observed = matchObservation(
      await this.observed.get(),
      [item.url, item.finalUrl ?? item.url],
      this.now(),
    );
    const released = await this.released.get();
    const own =
      (item.byExtensionId !== undefined && item.byExtensionId === this.deps.extensionId) ||
      released.includes(item.url) ||
      (item.finalUrl !== undefined && released.includes(item.finalUrl)) ||
      (observed !== undefined && this.ownRequest(observed));
    const prepared = await this.prepare(observed, item, own);
    if (!prepared || prepared.decision.action === 'leave') {
      if (prepared?.decision.action === 'leave') {
        this.deps.log.debug('intercept', `left in the browser (${prepared.decision.reason})`, {
          url: redactUrl(item.url),
        });
      }
      return;
    }
    const address = prepared.draft.finalUrl ?? prepared.draft.url;
    const claim = await this.claim(address);
    if (claim === 'taken') {
      // Captured while the request was paused, and a download entry appeared anyway.
      await this.erase(item.id);
      return;
    }
    if (claim !== 'won') return;
    const erased = await this.erase(item.id);
    if (!erased) {
      await this.settle(address, 'failed');
      return;
    }
    if (prepared.decision.action === 'ask') {
      await this.ask(prepared);
      return;
    }
    const result = await this.deliver(prepared.draft, prepared.name);
    await this.settle(address, result === 'failed' ? 'failed' : 'taken');
    if (result === 'failed') await this.fallback(address, prepared.draft.filename);
  }

  /** The person closed the ask window without choosing. The browser downloads the file. */
  async onWindowRemoved(windowId: number): Promise<void> {
    const pending = (await this.asks.get()).find(
      (ask) => ask.windowId === windowId && !ask.resolved,
    );
    if (!pending) return;
    await this.asks.update((list) => list.filter((ask) => ask.id !== pending.id));
    await this.fallback(pending.fallbackUrl, pending.filename);
  }

  /** What the ask page shows. Cookies are not included. */
  async askView(id: string): Promise<{ name: string; host: string } | null> {
    const pending = (await this.asks.get()).find((ask) => ask.id === id && !ask.resolved);
    return pending ? { name: pending.name, host: pending.host } : null;
  }

  /** The ask page's choice. */
  async choose(id: string, choice: AskChoice): Promise<void> {
    let pending: PendingAsk | undefined;
    await this.asks.update((list) => {
      pending = list.find((ask) => ask.id === id && !ask.resolved);
      return list.map((ask) => (ask.id === id ? { ...ask, resolved: true } : ask));
    });
    if (!pending) return;
    const chosen = pending;
    if (choice === 'browser') {
      await this.fallback(chosen.fallbackUrl, chosen.filename);
      return;
    }
    if (choice === 'always') {
      await this.deps.settings.update((settings) => ({
        ...settings,
        rules: {
          ...settings.rules,
          alwaysSites: [...new Set([...settings.rules.alwaysSites, chosen.host])],
        },
      }));
    }
    const result = await this.send(chosen.body, chosen.name);
    if (result === 'failed') await this.fallback(chosen.fallbackUrl, chosen.filename);
  }

  /** A prompt nobody answered is handed back to the browser. Called when the background loads. */
  async sweep(): Promise<void> {
    const now = this.now();
    const stale = (await this.asks.get()).filter(
      (ask) => !ask.resolved && now - ask.at > ASK_TTL_MS,
    );
    if (stale.length === 0) return;
    await this.asks.update((list) =>
      list.filter((ask) => ask.resolved || now - ask.at <= ASK_TTL_MS),
    );
    for (const ask of stale) await this.fallback(ask.fallbackUrl, ask.filename);
  }

  private async remember(event: RequestEvent, response: boolean): Promise<void> {
    const now = this.now();
    const disposition = headerValue(event.responseHeaders, 'content-disposition');
    const userAgent = headerValue(event.requestHeaders, 'user-agent');
    const length = contentLength(headerValue(event.responseHeaders, 'content-length'));
    const mime = headerValue(event.responseHeaders, 'content-type');
    const filename = filenameFromDisposition(disposition);
    const next: Observation = {
      requestId: event.requestId,
      url: event.url,
      method: event.method,
      tabId: event.tabId,
      requestHeaders: response ? {} : pickRequestHeaders(event.requestHeaders),
      incognito: event.incognito === true,
      attachment: response && isAttachment(disposition),
      at: now,
      ...(event.documentUrl ? { documentUrl: event.documentUrl } : {}),
      ...(event.initiator ? { initiator: event.initiator } : {}),
      ...(event.cookieStoreId ? { cookieStoreId: event.cookieStoreId } : {}),
      ...(response ? { finalUrl: event.url } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(mime ? { mime } : {}),
      ...(length !== undefined ? { sizeBytes: length } : {}),
      ...(filename ? { filename } : {}),
    };
    await this.observed.update((list) => {
      const previous = list.find((item) => item.requestId === event.requestId);
      return rememberObservation(list, mergeObservation(previous, next), now);
    });
  }

  private ownRequest(observed: Observation): boolean {
    return (
      observed.initiator !== undefined && observed.initiator.startsWith(this.deps.extensionOrigin)
    );
  }

  private async prepare(
    observed: Observation | undefined,
    item?: DownloadSnapshot,
    own?: boolean,
  ): Promise<
    { decision: ReturnType<typeof decide>; draft: CaptureDraft; name: string } | undefined
  > {
    const settings = await this.deps.settings.get();
    const url = observed?.url ?? item?.url;
    if (!url) return undefined;
    const finalUrl = item?.finalUrl ?? observed?.finalUrl ?? (item ? item.url : observed?.finalUrl);
    const gesture = readGesture(await this.gestures.get(), observed?.tabId, this.now());
    const facts: DownloadFacts = {
      url,
      incognito: item?.incognito ?? observed?.incognito ?? false,
      altKey: gesture.alt,
      shiftKey: gesture.shift,
      own: own ?? (observed !== undefined && this.ownRequest(observed)),
    };
    if (finalUrl) facts.finalUrl = finalUrl;
    if (observed?.method) facts.method = observed.method;
    const size = item?.sizeBytes ?? observed?.sizeBytes;
    if (size !== undefined) facts.sizeBytes = size;
    const filename = item?.filename ?? observed?.filename;
    if (filename) facts.filename = filename;
    const mime = item?.mime ?? observed?.mime;
    if (mime) facts.mime = mime;
    const decision = decide(settings.rules, facts);
    const referrer = item?.referrer || observed?.requestHeaders.referer || observed?.documentUrl;
    const pageUrl = observed?.documentUrl || referrer;
    const draft: CaptureDraft = { url };
    if (finalUrl) draft.finalUrl = finalUrl;
    if (pageUrl) draft.pageUrl = pageUrl;
    if (referrer) draft.referrer = referrer;
    if (filename) draft.filename = filename;
    if (mime) draft.mime = mime;
    if (size !== undefined) draft.sizeBytes = size;
    draft.userAgent = observed?.userAgent || this.deps.userAgent;
    if (observed && Object.keys(observed.requestHeaders).length > 0)
      draft.headers = observed.requestHeaders;
    if (decision.action !== 'leave') {
      const host = downloadHost(finalUrl ?? url);
      if (host) {
        draft.cookies = await this.readCookies(
          finalUrl ?? url,
          pageUrl,
          observed?.cookieStoreId,
          facts.incognito,
          settings.rules.privateWindows,
          host,
        );
      }
    }
    return { decision, draft, name: displayName(filename, finalUrl ?? url) };
  }

  private async readCookies(
    url: string,
    pageUrl: string | undefined,
    storeId: string | undefined,
    incognito: boolean,
    allowPrivate: boolean,
    host: string,
  ): Promise<CaptureCookie[]> {
    if (incognito && !allowPrivate) return [];
    const base: CookieQuery = storeId ? { url, storeId } : { url };
    const lists: BrowserCookieLike[][] = [];
    lists.push(await this.readCookieList(base));
    if (pageUrl) {
      try {
        const origin = new URL(pageUrl).origin;
        if (origin !== 'null') {
          lists.push(
            await this.readCookieList({ ...base, partitionKey: { topLevelSite: origin } }),
          );
        }
      } catch {
        // The page address is not a URL we can use as a partition key.
      }
    }
    const seen = new Set<string>();
    const cookies = [];
    for (const cookie of lists.flat()) {
      const mapped = toCaptureCookie(cookie, host);
      if (!mapped) continue;
      const key = `${mapped.domain}\n${mapped.name}\n${mapped.path ?? ''}\n${mapped.partitionKey ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(mapped);
    }
    return cookies;
  }

  private async readCookieList(query: CookieQuery): Promise<BrowserCookieLike[]> {
    try {
      return await this.deps.cookies.getAll(query);
    } catch (error) {
      this.deps.log.debug('intercept', 'cookies could not be read', { error });
      return [];
    }
  }

  /**
   * `won` the first time. A later event sees `taken` (DLM has it), `failed` (the browser keeps it) or `working`
   * (the other path has not finished).
   */
  private async claim(url: string): Promise<ClaimResult | 'won'> {
    const now = this.now();
    let outcome: ClaimResult | 'won' = 'working';
    await this.claims.update((list) => {
      const fresh = list.filter((item) => now - item.at <= CLAIM_TTL_MS);
      const existing = fresh.find((item) => item.url === url);
      if (existing) {
        outcome = existing.result;
        return fresh;
      }
      outcome = 'won';
      return [...fresh, { url, at: now, result: 'working' as const }];
    });
    return outcome;
  }

  private settle(url: string, result: ClaimResult): Promise<Claim[]> {
    return this.claims.update((list) =>
      list.map((item) => (item.url === url ? { ...item, result } : item)),
    );
  }

  /** Cancels and erases a download that already started. False when the browser would not cancel it. */
  private async erase(id: number): Promise<boolean> {
    try {
      await this.deps.downloads.cancel(id);
      await this.deps.downloads.erase({ id });
      return true;
    } catch (error) {
      this.deps.log.warn('intercept', 'could not cancel the browser download', { error });
      return false;
    }
  }

  /** A torrent file goes to the torrent upload; everything else is a capture. */
  private async deliver(draft: CaptureDraft, name: string): Promise<SendResult> {
    const address = draft.finalUrl ?? draft.url;
    if (
      this.deps.torrents &&
      isTorrent({
        url: address,
        ...(draft.filename ? { filename: draft.filename } : {}),
        ...(draft.mime ? { mime: draft.mime } : {}),
      })
    ) {
      const outcome = await this.deps.torrents.addTorrent({
        url: address,
        ...(draft.filename ? { filename: draft.filename } : {}),
        ...(draft.cookies ? { cookies: draft.cookies } : {}),
      });
      if (outcome === 'failed') {
        await this.notify('intercept.failed', name, t('intercept.reason.rejected'));
        return 'failed';
      }
      await this.bump();
      await this.notify('intercept.sent', name);
      return 'taken';
    }
    return this.send(buildCaptureBody(draft), name);
  }

  private async send(body: CaptureBody, name: string): Promise<SendResult> {
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') {
      await this.notify('intercept.failed', name, t('intercept.reason.offline'));
      return 'failed';
    }
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) {
      await this.notify('intercept.failed', name, t('intercept.reason.offline'));
      return 'failed';
    }
    try {
      await this.deps.client(state.baseUrl, token).capture(body);
      await this.bump();
      await this.notify('intercept.sent', name);
      return 'taken';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await this.bump();
        await this.notify('intercept.duplicate', name);
        return 'duplicate';
      }
      const reason =
        error instanceof ApiError || error instanceof NetworkError
          ? error.message
          : t('intercept.reason.rejected');
      this.deps.log.warn('intercept', 'capture failed', { error, url: redactUrl(body.url ?? '') });
      await this.notify('intercept.failed', name, reason);
      return 'failed';
    }
  }

  private async fallback(url: string, filename: string | undefined): Promise<void> {
    const name = basename(filename);
    await this.released.update((list) => [...list.filter((item) => item !== url), url].slice(-100));
    try {
      await this.deps.downloads.download(name ? { url, filename: name } : { url });
    } catch (error) {
      this.deps.log.error('intercept', 'could not restart the download in the browser', {
        error,
        url: redactUrl(url),
      });
    }
  }

  private async ask(prepared: { draft: CaptureDraft; name: string }): Promise<void> {
    const body = buildCaptureBody(prepared.draft);
    const host = downloadHost(prepared.draft.finalUrl ?? prepared.draft.url) ?? '';
    const pending: PendingAsk = {
      id: this.id(),
      host,
      name: prepared.name,
      fallbackUrl: prepared.draft.finalUrl ?? prepared.draft.url,
      body,
      resolved: false,
      at: this.now(),
      ...(prepared.draft.filename ? { filename: prepared.draft.filename } : {}),
    };
    await this.asks.update((list) => [...list.filter((ask) => ask.resolved), pending].slice(-20));
    try {
      const created = await this.deps.windows.create({
        url: this.deps.askUrl(pending.id),
        type: 'popup',
        width: 380,
        height: 220,
      });
      if (created.id === undefined) throw new Error('no window');
      await this.asks.update((list) =>
        list.map((ask) => (ask.id === pending.id ? { ...ask, windowId: created.id } : ask)),
      );
    } catch (error) {
      this.deps.log.warn('intercept', 'could not open the ask window', { error });
      await this.asks.update((list) => list.filter((ask) => ask.id !== pending.id));
      await this.fallback(pending.fallbackUrl, pending.filename);
    }
  }

  private async bump(): Promise<void> {
    const next = parseHandoffCount(await this.deps.session.get(HANDOFF_COUNT_KEY)) + 1;
    await this.deps.session.set(HANDOFF_COUNT_KEY, next);
    await this.deps.connection.repaint();
  }

  private async notify(
    key: 'intercept.sent' | 'intercept.duplicate' | 'intercept.failed',
    name: string,
    reason?: string,
  ): Promise<void> {
    const settings = await this.deps.settings.get();
    if (!settings.preferences.notifications) return;
    const message =
      key === 'intercept.failed'
        ? t(key, { name, reason: reason ?? t('intercept.reason.rejected') })
        : t(key, { name });
    try {
      await this.deps.notifications.create('dlm-intercept', {
        title: t('intercept.notify.title'),
        message,
        ...(this.deps.iconUrl ? { iconUrl: this.deps.iconUrl } : {}),
      });
    } catch (error) {
      this.deps.log.warn('intercept', 'could not notify', { error });
    }
  }
}
