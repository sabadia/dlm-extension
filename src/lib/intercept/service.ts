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
  withoutChecksum,
  displayName,
  filenameFromDisposition,
  headerValue,
  isAttachment,
  isDownloadType,
  pickRequestHeaders,
  sameOrigin,
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
import type { HintStore } from '../page/store';
import { targetFor } from '../settings/routing';
import { decodeBase64Text, isMultipart } from './post';
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
  /** Base64 body of a small POST, already size-checked. */
  postBody?: string | undefined;
}

/** What the browser fallback may ask of `downloads.download`. The port drops what the browser does not know. */
export interface DownloadOptions {
  url: string;
  filename?: string | undefined;
  /** A POST that is replayed in the browser. The body is text. */
  method?: 'POST' | undefined;
  body?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  /** Firefox: keep the download in the private window or container it started in. */
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
}

export interface DownloadsPort {
  cancel(id: number): Promise<void>;
  erase(query: { id: number }): Promise<number[]>;
  download(options: DownloadOptions): Promise<number>;
}

export interface CookieQuery {
  url: string;
  storeId?: string | undefined;
  partitionKey?: { topLevelSite: string } | undefined;
}

export interface CookiesPort {
  getAll(query: CookieQuery): Promise<BrowserCookieLike[]>;
  /** Chrome: the cookie stores and the tabs in each, to find the private window's store. Absent on Firefox. */
  stores?(): Promise<{ id: string; tabIds: number[] }[]>;
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
  /** Closes a window. Used to close an ask prompt that ran out of time. */
  remove?(id: number): Promise<void>;
}

/** What one capture call returns. Tests pass a fake; the real one is {@link DlmClient.capture}. */
export interface CaptureClient {
  capture(body: CaptureBody): Promise<unknown>;
}

export type AskChoice = 'dlm' | 'browser' | 'always' | 'omit';

export type AskPurpose = 'ask' | 'checksum';

/** What it takes to restart a download in the browser the way it started. */
export interface Replay {
  url: string;
  filename?: string | undefined;
  /** A POST: its text body (base64, as captured) and content type. */
  method?: 'POST' | undefined;
  body?: string | undefined;
  contentType?: string | undefined;
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
}

export interface PendingAsk {
  id: string;
  /** The site "always" remembers: the page the download started on, else the download's own host. */
  host: string;
  name: string;
  /** `ask` is ask-first. `checksum` reviews a hash and still sends the download when the window closes. */
  purpose: AskPurpose;
  fallback: Replay;
  body: CaptureBody;
  windowId?: number | undefined;
  at: number;
}

/** `working` is in progress, `taken` reached DLM, `failed` left the file with the browser. */
type ClaimResult = 'working' | 'taken' | 'failed';

/** One request (or, without an observation, one download item) being handled by exactly one path. */
interface Claim {
  key: string;
  at: number;
  result: ClaimResult;
}

/** A capture DLM answered with 409; the notification offers to add it anyway. Holds cookies: session storage only. */
interface Duplicate {
  id: string;
  name: string;
  body: CaptureBody;
  at: number;
}

/** A restarted download is left alone for this long. */
const RELEASED_TTL_MS = 60_000;
const DUPLICATE_TTL_MS = 5 * 60_000;
const MAX_DUPLICATES = 5;
/** Request details live this long in memory: the download item follows within milliseconds (spike E0.7). */
const REQUEST_TTL_MS = 15_000;
const MAX_REQUESTS = 300;
/** POST bodies are the big part of a request; only this many are kept at once. */
const MAX_CACHED_BODIES = 8;
export const DUPLICATE_PREFIX = 'dlm-duplicate:';

const CLAIM_TTL_MS = 60_000;
const ASK_TTL_MS = 2 * 60_000;
const OBSERVED_KEY = 'intercept.observed';
const GESTURE_KEY = 'intercept.gestures';
const RELEASED_KEY = 'intercept.released';
const CLAIM_KEY = 'intercept.claims';
const ASK_KEY = 'intercept.asks';
const DUPLICATE_KEY = 'intercept.duplicates';

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
    ...(typeof record.postBody === 'string' ? { postBody: record.postBody } : {}),
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

interface Released {
  url: string;
  at: number;
}

function parseReleased(raw: unknown): Released[] {
  return parseList((value) => {
    const record = asRecord(value);
    if (!record || typeof record.url !== 'string' || typeof record.at !== 'number')
      return undefined;
    return { url: record.url, at: record.at };
  })(raw);
}

function parseClaims(raw: unknown): Claim[] {
  return parseList((value) => {
    const record = asRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.at !== 'number')
      return undefined;
    return { key: record.key, at: record.at, result: claimResult(record.result) };
  })(raw);
}

function parseReplay(raw: unknown): Replay | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.url !== 'string') return undefined;
  return {
    url: record.url,
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    ...(record.method === 'POST' ? { method: 'POST' as const } : {}),
    ...(typeof record.body === 'string' ? { body: record.body } : {}),
    ...(typeof record.contentType === 'string' ? { contentType: record.contentType } : {}),
    ...(record.incognito === true ? { incognito: true } : {}),
    ...(typeof record.cookieStoreId === 'string' ? { cookieStoreId: record.cookieStoreId } : {}),
  };
}

function parseDuplicates(raw: unknown): Duplicate[] {
  return parseList((value) => {
    const record = asRecord(value);
    const body = asRecord(record?.body);
    if (
      !record ||
      !body ||
      typeof body.url !== 'string' ||
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.at !== 'number'
    )
      return undefined;
    return { id: record.id, name: record.name, body, at: record.at };
  })(raw);
}

function parseAsks(raw: unknown): PendingAsk[] {
  return parseList((value) => {
    const record = asRecord(value);
    if (!record || typeof record.id !== 'string' || typeof record.host !== 'string')
      return undefined;
    const fallback = parseReplay(record.fallback);
    if (typeof record.name !== 'string' || !fallback || typeof record.at !== 'number')
      return undefined;
    const body = asRecord(record.body);
    if (!body || typeof body.url !== 'string') return undefined;
    const purpose: AskPurpose = record.purpose === 'checksum' ? 'checksum' : 'ask';
    const pending: PendingAsk = {
      id: record.id,
      host: record.host,
      name: record.name,
      purpose,
      fallback,
      body,
      at: record.at,
      ...(typeof record.windowId === 'number' ? { windowId: record.windowId } : {}),
    };
    return pending;
  })(raw);
}

export interface InterceptDeps {
  settings: Pick<SettingsStore, 'get' | 'update'>;
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get' | 'repaint'> & {
    endpoint?(targetId: string): Promise<{ baseUrl: string; token: string } | undefined>;
  };
  /** Checksums and mirrors a page reported. Absent in tests that do not exercise them. */
  hints?: Pick<HintStore, 'find' | 'note'>;
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
    }): Promise<'taken' | 'duplicate' | 'failed'>;
  };
  now?: () => number;
  id?: () => string;
}

type SendResult = 'taken' | 'duplicate' | 'failed';

/** What the hand-off decided about one download, before anything was cancelled. */
interface Prepared {
  decision: ReturnType<typeof decide>;
  draft: CaptureDraft;
  name: string;
  /** The page the download started on, when known. */
  site: string | undefined;
  replay: Replay;
  /** False in a private window or a container: a torrent fetched by the extension would use the wrong cookies. */
  defaultStore: boolean;
}

/** A multipart form cannot be rebuilt from its parsed fields: such a POST stays with the browser. */
function withReplayableBody(observation: Observation): Observation {
  if (
    observation.postBody !== undefined &&
    isMultipart(observation.requestHeaders['content-type'])
  ) {
    return { ...observation, postBody: undefined };
  }
  return observation;
}

/**
 * Hands browser downloads to DLM. Listeners are registered by {@link registerBackground} while the background loads.
 *
 * What survives a restart of the worker is in `storage.session`. The one thing that is only in memory is the request
 * cache: headers and bodies of requests that are in flight, which live a few milliseconds until the response says
 * whether they were a download (a worker that is stopped in that window loses nothing but some metadata, and the
 * download is still handed over from its item). Writing every request to storage queued a write per request and, on
 * Firefox, held every response back behind them.
 */
export class InterceptService {
  private readonly observed: StoredValue<Observation[]>;
  private readonly gestures: StoredValue<Record<string, Gesture>>;
  private readonly released: StoredValue<Released[]>;
  private readonly claims: StoredValue<Claim[]>;
  private readonly asks: StoredValue<PendingAsk[]>;
  private readonly duplicates: StoredValue<Duplicate[]>;
  private readonly requests = new Map<string, Observation>();
  /** Every write of an observation, in order. `onCreated` waits for it so it never reads before the response is in. */
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: InterceptDeps) {
    this.observed = new StoredValue(deps.session, OBSERVED_KEY, parseList(parseObservation));
    this.gestures = new StoredValue(deps.session, GESTURE_KEY, parseGestureMap);
    this.released = new StoredValue(deps.session, RELEASED_KEY, parseReleased);
    this.claims = new StoredValue(deps.session, CLAIM_KEY, parseClaims);
    this.asks = new StoredValue(deps.session, ASK_KEY, parseAsks);
    this.duplicates = new StoredValue(deps.session, DUPLICATE_KEY, parseDuplicates);
    this.now = deps.now ?? (() => Date.now());
    this.id = deps.id ?? (() => crypto.randomUUID());
  }

  /** A content script reporting checksums and mirror links it saw. It cannot ask for a download. */
  noteHints(hints: Parameters<HintStore['note']>[0]): Promise<void> {
    return this.deps.hints?.note(hints, this.now()) ?? Promise.resolve();
  }

  /** A content script saw Alt or Shift. The tab id comes from the sender, not from the page. */
  noteGesture(tabId: number, alt: boolean, shift: boolean): Promise<void> {
    const now = this.now();
    return this.gestures
      .update((map) => rememberGesture(map, tabId, alt, shift, now))
      .then(() => undefined);
  }

  /** A POST body, cached in memory until the response says whether the request was a download. */
  onBeforeRequest(event: RequestEvent): void {
    this.cache(event);
  }

  /** Request headers, cached in memory until the response arrives. */
  onBeforeSendHeaders(event: RequestEvent): void {
    this.cache(event);
  }

  /**
   * Response headers: the request becomes an observation in storage. On Firefox an attachment that the rules take is
   * captured here and the request is cancelled, so no download entry appears (spike E0.7); every other response returns
   * at once, so the browser is never held back.
   */
  onHeadersReceived(event: RequestEvent): Promise<{ cancel: true } | void> | void {
    const next = this.toObservation(event, true);
    const merged = withReplayableBody(mergeObservation(this.requests.get(event.requestId), next));
    this.requests.delete(event.requestId);
    const own = this.ownRequest(merged);
    // A body is kept only for a response that looks like a download; every other POST body is dropped here.
    const kept: Observation =
      merged.attachment || isDownloadType(merged.mime)
        ? merged
        : { ...merged, postBody: undefined };
    const written = this.persist(kept);
    if (!this.deps.firefox || !kept.attachment || own) return;
    return written.then(() => this.captureBlocking(kept));
  }

  private async captureBlocking(current: Observation): Promise<{ cancel: true } | void> {
    const prepared = await this.prepare(current);
    // A checksum is reviewed on the download item, so the request is not cancelled here.
    if (!prepared || prepared.decision.action !== 'take' || prepared.draft.checksum) return;
    const key = current.requestId;
    if ((await this.claim(key)) !== 'won') return;
    let result: SendResult = 'failed';
    try {
      result = await this.dispatch(buildCaptureBody(prepared.draft), prepared.name, prepared);
    } catch (error) {
      this.deps.log.error('intercept', 'the hand-off failed', { error });
    }
    await this.settle(key, result === 'failed' ? 'failed' : 'taken');
    if (result === 'failed') return;
    return { cancel: true };
  }

  /** The common path (spike E0.7): cancel and erase, then hand the download to DLM. */
  async onCreated(item: DownloadSnapshot): Promise<void> {
    await this.writes;
    const observed = matchObservation(
      await this.observed.get(),
      [item.url, item.finalUrl ?? item.url],
      this.now(),
    );
    const own =
      (item.byExtensionId !== undefined && item.byExtensionId === this.deps.extensionId) ||
      (await this.wasReleased([item.url, item.finalUrl])) ||
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
    // One request is handled once. A repeat of the same address is a new request and is handled on its own.
    const key = observed?.requestId ?? `download:${item.id}`;
    const claim = await this.claim(key);
    if (claim === 'taken') {
      // Captured while the request was paused, and a download entry appeared anyway.
      await this.erase(item.id);
      return;
    }
    if (claim !== 'won') return;
    if (!(await this.erase(item.id))) {
      await this.settle(key, 'failed');
      return;
    }
    // The browser's copy is gone from here on: whatever goes wrong, the file must end up in DLM or in the browser.
    try {
      if (prepared.decision.action === 'ask') {
        await this.ask(prepared, 'ask');
        return;
      }
      if (prepared.draft.checksum) {
        await this.ask(prepared, 'checksum');
        return;
      }
      const result = await this.dispatch(buildCaptureBody(prepared.draft), prepared.name, prepared);
      await this.settle(key, result === 'failed' ? 'failed' : 'taken');
      if (result === 'failed') await this.fallback(prepared.replay);
    } catch (error) {
      this.deps.log.error('intercept', 'the hand-off failed', {
        error,
        url: redactUrl(item.url),
      });
      await this.settle(key, 'failed');
      await this.fallback(prepared.replay);
    }
  }

  /** The person closed the ask window without choosing. The browser downloads the file. */
  async onWindowRemoved(windowId: number): Promise<void> {
    let pending: PendingAsk | undefined;
    await this.asks.update((list) => {
      pending = list.find((ask) => ask.windowId === windowId);
      return list.filter((ask) => ask !== pending);
    });
    if (!pending) return;
    await this.resolveUnanswered(pending);
  }

  /** What the ask page shows. Cookies are not included. */
  async askView(id: string): Promise<{
    name: string;
    host: string;
    purpose: AskPurpose;
    checksum?: { algorithm: string; expected: string };
  } | null> {
    const pending = (await this.asks.get()).find((ask) => ask.id === id);
    if (!pending) return null;
    const checksum = pending.body.checksum;
    return {
      name: pending.name,
      host: pending.host,
      purpose: pending.purpose,
      ...(checksum
        ? { checksum: { algorithm: checksum.algorithm, expected: checksum.expected } }
        : {}),
    };
  }

  /** The ask page's choice. The prompt is forgotten at once, so a window closing afterwards finds nothing to undo. */
  async choose(id: string, choice: AskChoice): Promise<void> {
    let pending: PendingAsk | undefined;
    await this.asks.update((list) => {
      pending = list.find((ask) => ask.id === id);
      return list.filter((ask) => ask !== pending);
    });
    if (!pending) return;
    const chosen = pending;
    if (choice === 'omit' || (choice === 'browser' && chosen.purpose === 'checksum')) {
      await this.finish(withoutChecksum(chosen.body), chosen);
      return;
    }
    if (choice === 'browser') {
      await this.fallback(chosen.fallback);
      return;
    }
    if (choice === 'always' && chosen.host !== '') {
      await this.deps.settings.update((settings) => ({
        ...settings,
        rules: {
          ...settings.rules,
          alwaysSites: [...new Set([...settings.rules.alwaysSites, chosen.host])],
        },
      }));
    }
    await this.finish(chosen.body, chosen);
  }

  /**
   * A prompt nobody answered in time is closed and the download goes to the browser. Called when the background
   * loads, and by the notification click handler.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    let stale: PendingAsk[] = [];
    await this.asks.update((list) => {
      stale = list.filter((ask) => now - ask.at > ASK_TTL_MS);
      return list.filter((ask) => !stale.includes(ask));
    });
    for (const ask of stale) {
      if (ask.windowId !== undefined) {
        try {
          await this.deps.windows.remove?.(ask.windowId);
        } catch {
          // The window is gone already.
        }
      }
      await this.resolveUnanswered(ask);
    }
    await this.duplicates.update((list) =>
      list.filter((item) => now - item.at <= DUPLICATE_TTL_MS),
    );
  }

  /** The person clicked "Already in DLM": add it again, on purpose. Returns true when the click was ours. */
  async onNotificationClicked(notificationId: string): Promise<boolean> {
    if (!notificationId.startsWith(DUPLICATE_PREFIX)) return false;
    const id = notificationId.slice(DUPLICATE_PREFIX.length);
    let found: Duplicate | undefined;
    await this.duplicates.update((list) => {
      found = list.find((item) => item.id === id);
      return list.filter((item) => item !== found);
    });
    if (found && this.now() - found.at <= DUPLICATE_TTL_MS) {
      await this.send({ ...found.body, allowDuplicate: true }, found.name);
    }
    return true;
  }

  /** A prompt that was never answered: a checksum review still sends the file, ask-first goes to the browser. */
  private async resolveUnanswered(ask: PendingAsk): Promise<void> {
    if (ask.purpose === 'checksum') await this.finish(withoutChecksum(ask.body), ask);
    else await this.fallback(ask.fallback);
  }

  private cache(event: RequestEvent): void {
    const now = this.now();
    const next = this.toObservation(event, false);
    this.requests.set(
      event.requestId,
      withReplayableBody(mergeObservation(this.requests.get(event.requestId), next)),
    );
    for (const [id, item] of this.requests) {
      if (now - item.at > REQUEST_TTL_MS) this.requests.delete(id);
    }
    while (this.requests.size > MAX_REQUESTS) {
      const oldest = this.requests.keys().next().value;
      if (oldest === undefined) break;
      this.requests.delete(oldest);
    }
    let bodies = 0;
    for (const item of [...this.requests.values()].reverse()) {
      if (item.postBody === undefined) continue;
      bodies += 1;
      if (bodies > MAX_CACHED_BODIES) item.postBody = undefined;
    }
  }

  /** Writes one observation after the earlier writes. Never rejects; a storage error is logged. */
  private persist(observation: Observation): Promise<unknown> {
    const now = this.now();
    this.writes = this.writes
      .then(() => this.observed.update((list) => rememberObservation(list, observation, now)))
      .catch((error: unknown) => {
        this.deps.log.warn('intercept', 'could not remember a request', { error });
      });
    return this.writes;
  }

  private toObservation(event: RequestEvent, response: boolean): Observation {
    const now = this.now();
    const disposition = headerValue(event.responseHeaders, 'content-disposition');
    const userAgent = headerValue(event.requestHeaders, 'user-agent');
    const length = contentLength(headerValue(event.responseHeaders, 'content-length'));
    const mime = headerValue(event.responseHeaders, 'content-type');
    const filename = filenameFromDisposition(disposition);
    const initiator = event.initiator;
    // A request of this extension (the daemon, a fallback download) keeps no headers or body: it only has to be
    // recognised as ours.
    const ours = initiator !== undefined && initiator.startsWith(this.deps.extensionOrigin);
    const headers = response || ours ? {} : pickRequestHeaders(event.requestHeaders);
    const body = ours ? undefined : event.postBody;
    return {
      requestId: event.requestId,
      url: event.url,
      method: event.method,
      tabId: event.tabId,
      requestHeaders: headers,
      incognito: event.incognito === true,
      attachment: response && isAttachment(disposition),
      at: now,
      ...(event.documentUrl ? { documentUrl: event.documentUrl } : {}),
      ...(initiator ? { initiator } : {}),
      ...(event.cookieStoreId ? { cookieStoreId: event.cookieStoreId } : {}),
      ...(response ? { finalUrl: event.url } : {}),
      ...(userAgent && !ours ? { userAgent } : {}),
      ...(mime ? { mime } : {}),
      ...(length !== undefined ? { sizeBytes: length } : {}),
      ...(filename ? { filename } : {}),
      ...(body ? { postBody: body } : {}),
    };
  }

  private ownRequest(observed: Observation): boolean {
    return (
      observed.initiator !== undefined && observed.initiator.startsWith(this.deps.extensionOrigin)
    );
  }

  private async wasReleased(urls: readonly (string | undefined)[]): Promise<boolean> {
    const now = this.now();
    const fresh = (await this.released.get()).filter((item) => now - item.at <= RELEASED_TTL_MS);
    return fresh.some((item) => urls.includes(item.url));
  }

  private async prepare(
    observed: Observation | undefined,
    item?: DownloadSnapshot,
    own?: boolean,
  ): Promise<Prepared | undefined> {
    const settings = await this.deps.settings.get();
    const url = observed?.url ?? item?.url;
    if (!url) return undefined;
    const finalUrl = item?.finalUrl ?? observed?.finalUrl ?? (item ? item.url : observed?.finalUrl);
    const gesture = readGesture(await this.gestures.get(), observed?.tabId, this.now());
    // The browser reports 0 (or -1) for a size it does not know; that is not a small file.
    const size = [item?.sizeBytes, observed?.sizeBytes].find(
      (value): value is number => value !== undefined && value > 0,
    );
    const facts: DownloadFacts = {
      url,
      incognito: item?.incognito ?? observed?.incognito ?? false,
      altKey: gesture.alt,
      shiftKey: gesture.shift,
      own: own ?? (observed !== undefined && this.ownRequest(observed)),
    };
    if (finalUrl) facts.finalUrl = finalUrl;
    if (observed?.documentUrl) facts.pageUrl = observed.documentUrl;
    if (observed?.method) facts.method = observed.method;
    if (observed?.postBody) facts.postBody = observed.postBody;
    if (size !== undefined) facts.sizeBytes = size;
    const filename = item?.filename ?? observed?.filename;
    if (filename) facts.filename = filename;
    const mime = item?.mime ?? observed?.mime;
    if (mime) facts.mime = mime;
    const decision = decide(settings.rules, facts);
    // The referrer is what the browser sent. The page address is its own field; it is not made into a referrer.
    const referrer = item?.referrer || observed?.requestHeaders.referer;
    const pageUrl = observed?.documentUrl || referrer;
    const draft: CaptureDraft = { url };
    if (finalUrl) draft.finalUrl = finalUrl;
    if (pageUrl) draft.pageUrl = pageUrl;
    if (referrer) draft.referrer = referrer;
    if (filename) draft.filename = filename;
    if (mime) draft.mime = mime;
    if (size !== undefined) draft.sizeBytes = size;
    draft.userAgent = observed?.userAgent || this.deps.userAgent;
    if (observed && Object.keys(observed.requestHeaders).length > 0) {
      const headers = { ...observed.requestHeaders };
      // Browsers drop `Authorization` on a redirect to another origin; so does the hand-off.
      if (finalUrl && !sameOrigin(url, finalUrl)) delete headers.authorization;
      if (Object.keys(headers).length > 0) draft.headers = headers;
    }
    const replayBody = observed?.method.toUpperCase() === 'POST' ? observed.postBody : undefined;
    if (replayBody) {
      draft.method = 'POST';
      draft.body = replayBody;
    }
    const incognito = facts.incognito;
    const storeId = observed?.cookieStoreId;
    if (decision.action !== 'leave') {
      const host = downloadHost(finalUrl ?? url);
      if (host) {
        draft.cookies = await this.readCookies(
          finalUrl ?? url,
          pageUrl,
          storeId,
          observed?.tabId,
          incognito,
          settings.rules.privateWindows,
          host,
        );
      }
    }
    const address = finalUrl ?? url;
    const contentType = observed?.requestHeaders['content-type'];
    const replay: Replay = {
      url: address,
      ...(filename ? { filename } : {}),
      ...(replayBody ? { method: 'POST' as const, body: replayBody } : {}),
      ...(replayBody && contentType ? { contentType } : {}),
      ...(incognito ? { incognito: true } : {}),
      ...(storeId ? { cookieStoreId: storeId } : {}),
    };
    return {
      decision,
      draft: await this.applyHints(draft, settings),
      name: displayName(filename, address),
      site: observed?.documentUrl ? downloadHost(observed.documentUrl) : undefined,
      replay,
      defaultStore: !incognito && (storeId === undefined || /default$/.test(storeId)),
    };
  }

  /** Adds a checksum, and mirror links when the user has turned that on. */
  private async applyHints(
    draft: CaptureDraft,
    settings: Awaited<ReturnType<SettingsStore['get']>>,
  ): Promise<CaptureDraft> {
    if (!this.deps.hints) return draft;
    const urls = [draft.finalUrl, draft.url].filter((url): url is string => Boolean(url));
    const hint = await this.deps.hints.find(urls, this.now());
    if (!hint) return draft;
    return {
      ...draft,
      ...(hint.checksum ? { checksum: hint.checksum } : {}),
      ...(settings.preferences.mirrors && hint.mirrors && hint.mirrors.length > 0
        ? { mirrors: hint.mirrors }
        : {}),
    };
  }

  private async readCookies(
    url: string,
    pageUrl: string | undefined,
    storeId: string | undefined,
    tabId: number | undefined,
    incognito: boolean,
    allowPrivate: boolean,
    host: string,
  ): Promise<CaptureCookie[]> {
    if (incognito && !allowPrivate) return [];
    const store = storeId ?? (await this.storeOfTab(tabId));
    const base: CookieQuery = store ? { url, storeId: store } : { url };
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

  /** Chrome: webRequest has no cookie store, but the stores know their tabs (a private window has a store of its own). */
  private async storeOfTab(tabId: number | undefined): Promise<string | undefined> {
    if (tabId === undefined || tabId < 0 || !this.deps.cookies.stores) return undefined;
    try {
      const stores = await this.deps.cookies.stores();
      return stores.find((store) => store.tabIds.includes(tabId))?.id;
    } catch (error) {
      this.deps.log.debug('intercept', 'cookie stores could not be listed', { error });
      return undefined;
    }
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
   * `won` the first time. A later event for the same request sees `taken` (DLM has it), `failed` (the browser keeps
   * it) or `working` (the other path has not finished).
   */
  private async claim(key: string): Promise<ClaimResult | 'won'> {
    const now = this.now();
    let outcome: ClaimResult | 'won' = 'working';
    await this.claims.update((list) => {
      const fresh = list.filter((item) => now - item.at <= CLAIM_TTL_MS);
      const existing = fresh.find((item) => item.key === key);
      if (existing) {
        outcome = existing.result;
        return fresh;
      }
      outcome = 'won';
      return [...fresh, { key, at: now, result: 'working' as const }];
    });
    return outcome;
  }

  private settle(key: string, result: ClaimResult): Promise<Claim[]> {
    return this.claims.update((list) =>
      list.map((item) => (item.key === key ? { ...item, result } : item)),
    );
  }

  /**
   * Cancels and erases a download that already started. False only when the browser would not cancel it, so the
   * download is still running in the browser. A cancelled entry that cannot be erased is a leftover in the list, not a
   * reason to lose the file.
   */
  private async erase(id: number): Promise<boolean> {
    try {
      await this.deps.downloads.cancel(id);
    } catch (error) {
      this.deps.log.warn('intercept', 'could not cancel the browser download', { error });
      return false;
    }
    try {
      await this.deps.downloads.erase({ id });
    } catch (error) {
      this.deps.log.warn('intercept', 'could not erase the cancelled download', { error });
    }
    return true;
  }

  /**
   * A torrent file goes to the torrent upload; everything else is a capture. A torrent started in a private window or a
   * container is captured with its own cookies instead: the extension would fetch it with the wrong ones.
   */
  private async dispatch(
    body: CaptureBody,
    name: string,
    prepared: Pick<Prepared, 'defaultStore'>,
  ): Promise<SendResult> {
    const address = body.finalUrl ?? body.url ?? '';
    if (
      this.deps.torrents &&
      prepared.defaultStore &&
      isTorrent({
        url: address,
        ...(body.filename ? { filename: body.filename } : {}),
        ...(body.mime ? { mime: body.mime } : {}),
      })
    ) {
      const outcome = await this.deps.torrents.addTorrent({
        url: address,
        ...(body.filename ? { filename: body.filename } : {}),
        ...(body.cookies ? { cookies: body.cookies } : {}),
      });
      if (outcome === 'failed') {
        await this.notify('intercept.failed', name, t('intercept.reason.rejected'));
        return 'failed';
      }
      await this.bump();
      if (outcome === 'duplicate') {
        await this.notifyDuplicate(body, name);
        return 'duplicate';
      }
      await this.notify('intercept.sent', name);
      return 'taken';
    }
    return this.send(body, name);
  }

  private async finish(body: CaptureBody, pending: PendingAsk): Promise<void> {
    let result: SendResult = 'failed';
    try {
      result = await this.dispatch(body, pending.name, {
        defaultStore: !pending.fallback.incognito && pending.fallback.cookieStoreId === undefined,
      });
    } catch (error) {
      this.deps.log.error('intercept', 'the hand-off failed', { error });
    }
    if (result === 'failed') await this.fallback(pending.fallback);
  }

  private async send(body: CaptureBody, name: string): Promise<SendResult> {
    const routed = await this.routedClient(body.url ?? '');
    if (!routed) {
      await this.notify('intercept.failed', name, t('intercept.reason.offline'));
      return 'failed';
    }
    try {
      await routed.capture(body);
      await this.bump();
      await this.notify('intercept.sent', name);
      return 'taken';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await this.bump();
        await this.notifyDuplicate(body, name);
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

  /** Restarts a download in the browser, the way it started. The restarted download is left alone for a minute. */
  private async fallback(replay: Replay): Promise<void> {
    const now = this.now();
    await this.released.update((list) =>
      [
        ...list.filter((item) => item.url !== replay.url && now - item.at <= RELEASED_TTL_MS),
        { url: replay.url, at: now },
      ].slice(-100),
    );
    const name = basename(replay.filename);
    const options: DownloadOptions = { url: replay.url, ...(name ? { filename: name } : {}) };
    if (replay.method === 'POST' && replay.body !== undefined) {
      options.method = 'POST';
      options.body = decodeBase64Text(replay.body);
      if (replay.contentType)
        options.headers = [{ name: 'Content-Type', value: replay.contentType }];
    }
    if (replay.incognito) options.incognito = true;
    if (replay.cookieStoreId) options.cookieStoreId = replay.cookieStoreId;
    try {
      await this.deps.downloads.download(options);
    } catch (error) {
      this.deps.log.error('intercept', 'could not restart the download in the browser', {
        error,
        url: redactUrl(replay.url),
      });
    }
  }

  /** The client for the target this address routes to, or the active connection when routing is not wired. */
  private async routedClient(url: string): Promise<CaptureClient | undefined> {
    if (this.deps.connection.endpoint) {
      const settings = await this.deps.settings.get();
      const endpoint = await this.deps.connection.endpoint(targetFor(settings, url));
      return endpoint ? this.deps.client(endpoint.baseUrl, endpoint.token) : undefined;
    }
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') return undefined;
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) return undefined;
    return this.deps.client(state.baseUrl, token);
  }

  private async ask(prepared: Prepared, purpose: AskPurpose): Promise<void> {
    const body = buildCaptureBody(prepared.draft);
    const now = this.now();
    const pending: PendingAsk = {
      id: this.id(),
      host: prepared.site ?? downloadHost(prepared.draft.finalUrl ?? prepared.draft.url) ?? '',
      name: prepared.name,
      fallback: prepared.replay,
      body,
      purpose,
      at: now,
    };
    // Prompts that are still open stay: a page can start two downloads at once.
    await this.asks.update((list) =>
      [...list.filter((ask) => now - ask.at <= ASK_TTL_MS), pending].slice(-20),
    );
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
      await this.fallback(pending.fallback);
    }
  }

  private async bump(): Promise<void> {
    const next = parseHandoffCount(await this.deps.session.get(HANDOFF_COUNT_KEY)) + 1;
    await this.deps.session.set(HANDOFF_COUNT_KEY, next);
    await this.deps.connection.repaint();
  }

  /** DLM already has it: say so, and let the person add it again by clicking the notification. */
  private async notifyDuplicate(body: CaptureBody, name: string): Promise<void> {
    const id = this.id();
    const now = this.now();
    await this.duplicates.update((list) =>
      [
        ...list.filter((item) => now - item.at <= DUPLICATE_TTL_MS),
        { id, name, body, at: now },
      ].slice(-MAX_DUPLICATES),
    );
    await this.notify('intercept.duplicate', name, undefined, `${DUPLICATE_PREFIX}${id}`);
  }

  private async notify(
    key: 'intercept.sent' | 'intercept.duplicate' | 'intercept.failed',
    name: string,
    reason?: string,
    notificationId = 'dlm-intercept',
  ): Promise<void> {
    const settings = await this.deps.settings.get();
    if (!settings.preferences.notifications) return;
    const message =
      key === 'intercept.failed'
        ? t(key, { name, reason: reason ?? t('intercept.reason.rejected') })
        : t(key, { name });
    try {
      await this.deps.notifications.create(notificationId, {
        title: t('intercept.notify.title'),
        message,
        ...(this.deps.iconUrl ? { iconUrl: this.deps.iconUrl } : {}),
      });
    } catch (error) {
      this.deps.log.warn('intercept', 'could not notify', { error });
    }
  }
}
