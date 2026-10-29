/**
 * Redaction. Everything that is shown to a person or written to the log goes through here first: tokens, cookies and
 * credentials never reach a log line, an error message or a diagnostics report (docs/CONVENTIONS.md, "Secrets").
 */

const MASK = '***';

/** Query parameters whose value is a secret, compared in lower case. */
const SECRET_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'key',
  'auth',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'sig',
  'signature',
  'session',
  'sessionid',
  'code',
]);

/** Object keys whose value is a secret, compared in lower case. */
const SECRET_KEYS = new Set([
  'token',
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'value',
  'body',
  'headers',
  'username',
]);

/** A DLM token, as issued by the daemon (`dlmt_…` for extensions, `dlm_…` for the others). */
const DLM_TOKEN = /\bdlm[a-z]?_[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const HEADER_LINE = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]*/gi;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi;

/**
 * Redacts one URL: the user and password part and the value of every secret query parameter (and of a fragment, which
 * single-page sites use for tokens). Text that is not a URL is returned unchanged.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    // Data URLs carry whole files: keep the type only.
    return `${url.protocol}${MASK}`;
  }
  if (url.username || url.password) {
    url.username = MASK;
    url.password = '';
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) url.searchParams.set(name, MASK);
  }
  if (url.hash.length > 1) url.hash = MASK;
  // `URLSearchParams` percent-encodes `*`; show the mask as written.
  return url.toString().replaceAll('%2A%2A%2A', MASK);
}

/** Redacts free text: tokens, authorization and cookie headers, and every URL inside it. */
export function redactText(text: string): string {
  return text
    .replace(HEADER_LINE, (_m, name: string) => `${name}: ${MASK}`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${MASK}`)
    .replace(DLM_TOKEN, MASK)
    .replace(URL_IN_TEXT, (url) => redactUrl(url));
}

/**
 * Redacts a structured value (a log field, an error's details): secret-named keys lose their value, strings go through
 * {@link redactText}. The input is not changed.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[too deep]';
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? MASK : redactValue(v, depth + 1);
  }
  return out;
}
