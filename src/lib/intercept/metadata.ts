import type { CaptureBody, CaptureCookie } from '../api/client';
import type { Checksum } from '../page/hints';

/**
 * Request headers repeated on the capture. `Cookie` and `Host` are refused by the daemon; the user agent and the
 * referrer also have fields of their own, and the user agent is sent there. Anything else the page set stays out
 * (docs/CONVENTIONS.md, "Least data").
 */
export const REQUEST_HEADER_ALLOW = [
  'accept',
  'accept-language',
  'authorization',
  'referer',
] as const;

export interface RawHeader {
  name?: string | undefined;
  value?: string | undefined;
}

/** The allow-listed request headers, names in lower case. Repeated headers are joined. */
export function pickRequestHeaders(
  headers: readonly RawHeader[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined) continue;
    const name = header.name.toLowerCase();
    if (!REQUEST_HEADER_ALLOW.some((allowed) => allowed === name)) continue;
    const value = header.value.trim();
    if (value === '') continue;
    const previous = out[name];
    out[name] = previous ? `${previous}, ${value}` : value;
  }
  return out;
}

/** One response header, or undefined when the response did not send it. */
export function headerValue(
  headers: readonly RawHeader[] | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  const values = (headers ?? []).flatMap((header) => {
    if (header.name?.toLowerCase() !== wanted || header.value === undefined) return [];
    const value = header.value.trim();
    return value === '' ? [] : [value];
  });
  return values.length > 0 ? values.join(', ') : undefined;
}

/** The file name from a `Content-Disposition` value, including the UTF-8 `filename*` form. */
export function filenameFromDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(value);
  const extendedName = extended?.[1]?.trim().replace(/^"(.*)"$/, '$1');
  if (extendedName) {
    try {
      return safeName(decodeURIComponent(extendedName));
    } catch {
      return safeName(extendedName);
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^";]+)/i.exec(value);
  return safeName(plain?.[1] ?? plain?.[2]);
}

/** True when the response tells the browser to download rather than show the body. */
export function isAttachment(value: string | undefined): boolean {
  return value !== undefined && /attachment/i.test(value);
}

/** A `Content-Length` in bytes, or undefined when it is missing or not a number. */
export function contentLength(value: string | undefined): number | undefined {
  const first = value?.split(',')[0]?.trim();
  if (!first) return undefined;
  const parsed = Number(first);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/** The last part of a path. A browser file name on Firefox is a full path; the daemon keeps the last part. */
export function basename(path: string | undefined): string | undefined {
  return safeName(path?.split(/[/\\]/).pop());
}

function safeName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === '.' || name === '..') return undefined;
  return name;
}

/** A cookie as the browser's `cookies.getAll` returns it. Only the fields the capture uses. */
export interface BrowserCookieLike {
  domain?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  sameSite?: string | undefined;
  hostOnly?: boolean | undefined;
  expirationDate?: number | undefined;
  session?: boolean | undefined;
  partitionKey?: { topLevelSite?: string | undefined } | string | undefined;
}

/** True when a cookie for `domain` would be sent to `host`. */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const bare = domain.replace(/^\./, '').toLowerCase();
  const wanted = host.toLowerCase();
  return wanted === bare || wanted.endsWith(`.${bare}`);
}

/**
 * One cookie for the capture body, or undefined when it is not for `host` or has no name. Session cookies have no
 * expiry. The partition key is the top-level site Chrome reports, unchanged.
 */
export function toCaptureCookie(
  cookie: BrowserCookieLike,
  host: string,
): CaptureCookie | undefined {
  if (!cookie.domain || !cookie.name || cookie.value === undefined) return undefined;
  if (!cookieMatchesHost(cookie.domain, host)) return undefined;
  const mapped: CaptureCookie = { domain: cookie.domain, name: cookie.name, value: cookie.value };
  if (cookie.path) mapped.path = cookie.path;
  if (cookie.secure) mapped.secure = true;
  if (cookie.httpOnly) mapped.httpOnly = true;
  if (cookie.hostOnly) mapped.hostOnly = true;
  const site = sameSiteOf(cookie.sameSite);
  if (site) mapped.sameSite = site;
  const partition = partitionOf(cookie.partitionKey);
  if (partition) mapped.partitionKey = partition;
  if (
    !cookie.session &&
    cookie.expirationDate !== undefined &&
    Number.isFinite(cookie.expirationDate)
  ) {
    const date = new Date(cookie.expirationDate * 1000);
    if (!Number.isNaN(date.getTime())) mapped.expiresAt = date.toISOString();
  }
  return mapped;
}

function sameSiteOf(value: string | undefined): CaptureCookie['sameSite'] | undefined {
  const text = value?.toLowerCase();
  if (text === 'lax' || text === 'strict') return text;
  if (text === 'none' || text === 'no_restriction') return 'none';
  return undefined;
}

function partitionOf(value: BrowserCookieLike['partitionKey']): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (value && typeof value === 'object' && value.topLevelSite) return value.topLevelSite;
  return undefined;
}

/** What the hand-off knows about a download once the browser item and the webRequest cache are joined. */
export interface CaptureDraft {
  url: string;
  finalUrl?: string | undefined;
  pageUrl?: string | undefined;
  referrer?: string | undefined;
  filename?: string | undefined;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  userAgent?: string | undefined;
  headers?: Record<string, string> | undefined;
  cookies?: CaptureCookie[] | undefined;
  /** Set for a POST whose body is small enough to replay. GET is omitted. */
  method?: string | undefined;
  /** Base64 body of that POST. */
  body?: string | undefined;
  checksum?: Checksum | undefined;
  mirrors?: string[] | undefined;
}

/** The capture body. Cookies are kept for this task only (`cookieScope: task`). GET is omitted: it is the default. */
export function buildCaptureBody(draft: CaptureDraft): CaptureBody {
  const body: CaptureBody = { url: draft.url, cookieScope: 'task' };
  if (draft.finalUrl) body.finalUrl = draft.finalUrl;
  if (draft.pageUrl) body.pageUrl = draft.pageUrl;
  if (draft.referrer) body.referrer = draft.referrer;
  const name = basename(draft.filename);
  if (name) body.filename = name;
  const mime = draft.mime?.split(';')[0]?.trim();
  if (mime) body.mime = mime;
  if (draft.sizeBytes !== undefined) body.size = draft.sizeBytes;
  if (draft.userAgent) body.userAgent = draft.userAgent;
  if (draft.headers && Object.keys(draft.headers).length > 0) body.headers = draft.headers;
  if (draft.cookies && draft.cookies.length > 0) body.cookies = draft.cookies;
  if (draft.method && draft.method.toUpperCase() !== 'GET')
    body.method = draft.method.toUpperCase();
  if (draft.body) body.body = draft.body;
  if (draft.checksum) body.checksum = draft.checksum;
  if (draft.mirrors && draft.mirrors.length > 0) body.mirrors = draft.mirrors.slice(0, 16);
  return body;
}

/** The same capture without the checksum the user chose not to send. */
export function withoutChecksum(body: CaptureBody): CaptureBody {
  const rest = { ...body };
  delete rest.checksum;
  return rest;
}

/** A short name for a notification. Never the query string, where a token might sit. */
export function displayName(filename: string | undefined, url: string): string {
  const name = basename(filename);
  if (name) return name;
  try {
    const parsed = new URL(url);
    return basename(parsed.pathname) ?? parsed.hostname;
  } catch {
    return 'download';
  }
}
