/**
 * What `webRequest` saw for one request, kept for a few seconds until `downloads.onCreated` (spike E0.7: the headers
 * arrive 1 to 9 ms first). Firefox's download item has no final address and no referrer, so those come from here.
 */

/** How long an observation is useful. A download item arrives within milliseconds; this only covers a slow machine. */
export const OBSERVATION_TTL_MS = 15_000;

/** How long a held modifier key still counts as the one that started the download. */
export const GESTURE_TTL_MS = 3_000;

export interface Observation {
  requestId: string;
  /** The address before redirects (the first `onBeforeSendHeaders`). */
  url: string;
  /** The address of the latest `onHeadersReceived`. */
  finalUrl?: string | undefined;
  method: string;
  tabId: number;
  documentUrl?: string | undefined;
  initiator?: string | undefined;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  filename?: string | undefined;
  /** Allow-listed request headers only. */
  requestHeaders: Record<string, string>;
  /** The user agent of the request, when the browser sent one. */
  userAgent?: string | undefined;
  /** Firefox container or private-window cookie store. */
  cookieStoreId?: string | undefined;
  incognito: boolean;
  /** True when `Content-Disposition` says attachment. */
  attachment: boolean;
  /** Base64 body of a small POST. Absent for GET and for a body this extension will not replay. */
  postBody?: string | undefined;
  at: number;
}

export interface Gesture {
  alt: boolean;
  shift: boolean;
  at: number;
}

const MAX_OBSERVATIONS = 50;

/** Adds `next` and drops observations that are too old or the previous record of the same request. */
export function rememberObservation(
  list: readonly Observation[],
  next: Observation,
  now: number,
): Observation[] {
  const kept = list.filter(
    (item) => now - item.at <= OBSERVATION_TTL_MS && item.requestId !== next.requestId,
  );
  return [...kept, next].slice(-MAX_OBSERVATIONS);
}

/** The newest observation whose address is one of `urls`. */
export function matchObservation(
  list: readonly Observation[],
  urls: readonly string[],
  now: number,
): Observation | undefined {
  const wanted = new Set(urls);
  return list
    .filter(
      (item) =>
        now - item.at <= OBSERVATION_TTL_MS &&
        (wanted.has(item.url) || (item.finalUrl !== undefined && wanted.has(item.finalUrl))),
    )
    .sort((a, b) => b.at - a.at)[0];
}

/** Merges a later event for the same request. The first address and the request headers stay. */
export function mergeObservation(
  previous: Observation | undefined,
  next: Observation,
): Observation {
  if (!previous) return next;
  return {
    ...next,
    url: previous.url,
    requestHeaders:
      Object.keys(previous.requestHeaders).length > 0
        ? previous.requestHeaders
        : next.requestHeaders,
    userAgent: previous.userAgent ?? next.userAgent,
    documentUrl: next.documentUrl ?? previous.documentUrl,
    initiator: next.initiator ?? previous.initiator,
    cookieStoreId: next.cookieStoreId ?? previous.cookieStoreId,
    filename: next.filename ?? previous.filename,
    mime: next.mime ?? previous.mime,
    sizeBytes: next.sizeBytes ?? previous.sizeBytes,
    finalUrl: next.finalUrl ?? previous.finalUrl,
    attachment: next.attachment || previous.attachment,
    postBody: previous.postBody ?? next.postBody,
  };
}

/** Remembers the modifier keys of one tab and forgets gestures that have expired. */
export function rememberGesture(
  map: Readonly<Record<string, Gesture>>,
  tabId: number,
  alt: boolean,
  shift: boolean,
  now: number,
): Record<string, Gesture> {
  const next: Record<string, Gesture> = {};
  for (const [id, gesture] of Object.entries(map)) {
    if (now - gesture.at <= GESTURE_TTL_MS) next[id] = gesture;
  }
  next[String(tabId)] = { alt, shift, at: now };
  return next;
}

/** The modifier keys held in `tab` a moment ago, or neither when there is no fresh gesture. */
export function readGesture(
  map: Readonly<Record<string, Gesture>>,
  tabId: number | undefined,
  now: number,
): { alt: boolean; shift: boolean } {
  if (tabId === undefined) return { alt: false, shift: false };
  const gesture = map[String(tabId)];
  if (!gesture || now - gesture.at > GESTURE_TTL_MS) return { alt: false, shift: false };
  return { alt: gesture.alt, shift: gesture.shift };
}
