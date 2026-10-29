/** Why a server address was refused. */
export type UrlProblem = 'empty' | 'invalid' | 'scheme' | 'credentials';

export type UrlResult = { ok: true; url: string } | { ok: false; problem: UrlProblem };

/**
 * Turns what a person typed into the base address of a DLM server: `http` or `https` only, no user name or password in
 * it (credentials in a URL end up in logs and history), no query or fragment, no trailing slash.
 */
export function normalizeBaseUrl(input: string): UrlResult {
  const text = input.trim();
  if (text === '') return { ok: false, problem: 'empty' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, problem: 'scheme' };
  if (url.username || url.password) return { ok: false, problem: 'credentials' };
  if (url.hostname === '') return { ok: false, problem: 'invalid' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

/** Whether the address is this computer: loopback names and addresses. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * The match pattern that grants the extension access to a server (`https://dlm.example.test/*`). Match patterns have no
 * port, so access is per host name.
 */
export function originPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}
