import type { Rules } from '../settings/schema';

/**
 * What the browser knows about one download, with nothing the rules do not need. Built by the hand-off from the
 * download item, the webRequest cache and the last modifier keys; the rules themselves stay free of browser APIs.
 */
export interface DownloadFacts {
  /** The address the user started. `blob:` and `data:` stay in the browser. */
  url: string;
  /** The address after redirects, when the browser or webRequest knows it. */
  finalUrl?: string;
  /** The page the download was started from. Site rules also apply to it (a CDN host alone says little). */
  pageUrl?: string;
  /** Bytes, when known. Unknown is not treated as smaller than the minimum. */
  sizeBytes?: number;
  /** The file name the browser chose, or the last part of the address. */
  filename?: string;
  /** The response content type, parameters allowed (`text/plain; charset=utf-8`). */
  mime?: string;
  /** HTTP method. Absent counts as GET. GET is handed over. A POST is handed over only when its body is small enough to replay. */
  method?: string;
  /** Base64 body of a small POST. Absent means the POST stays in the browser. */
  postBody?: string;
  /** A private window. */
  incognito: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** This extension started the download (a fallback, or `byExtensionId`). */
  own: boolean;
}

/** Why a download stays in the browser. `ask` is not a reason to leave: the person is asked. */
export type LeaveReason =
  'own' | 'scheme' | 'method' | 'off' | 'private' | 'bypass' | 'site' | 'size' | 'type';

export type Decision =
  { action: 'take' } | { action: 'leave'; reason: LeaveReason } | { action: 'ask' };

const HANDED_SCHEMES = new Set(['http:', 'https:', 'ftp:']);

/** The host of an http(s) or ftp address, lower case, or undefined when the address is not one we can hand over. */
export function downloadHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!HANDED_SCHEMES.has(parsed.protocol) || parsed.hostname === '') return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when `host` is `rule` or a subdomain of it. Both are already normalised. */
export function hostCoveredBy(host: string, rule: string): boolean {
  return host === rule || host.endsWith(`.${rule}`);
}

function listed(host: string, rules: readonly string[]): boolean {
  return rules.some((rule) => hostCoveredBy(host, rule));
}

/** The extension of a file name or address, without the dot, or undefined when there is none. */
export function fileExtension(filename: string | undefined, url: string): string | undefined {
  const fromName = extensionOf(filename);
  if (fromName) return fromName;
  try {
    return extensionOf(new URL(url).pathname);
  } catch {
    return undefined;
  }
}

function extensionOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function mimeMatches(actual: string, expected: string): boolean {
  const bare = actual.split(';')[0]?.trim().toLowerCase() ?? '';
  if (expected.endsWith('/')) return bare.startsWith(expected);
  return bare === expected;
}

/**
 * Whether the type lists allow this download. An empty list allows everything. When a list is set and the download
 * does not say its extension or type, it does not match that list. When both lists are set, either match is enough.
 */
export function typeAllowed(rules: Rules, facts: DownloadFacts, url: string): boolean {
  const files = rules.fileTypes;
  const mimes = rules.mimeTypes;
  if (files.length === 0 && mimes.length === 0) return true;
  const ext = fileExtension(facts.filename, url);
  const fileOk = ext !== undefined && files.includes(ext);
  const mimeOk =
    facts.mime !== undefined && mimes.some((mime) => mimeMatches(facts.mime ?? '', mime));
  if (files.length > 0 && mimes.length > 0) return fileOk || mimeOk;
  if (files.length > 0) return fileOk;
  return mimeOk;
}

/**
 * What to do with one download. The first matching rule wins, and the order is fixed: our own downloads, addresses
 * the daemon cannot fetch, a method that is not GET or a small POST, the global switch, private windows, the bypass key, an excluded site,
 * a site set to always (the start address, the final address or the page), then size, type and ask-first.
 */
export function decide(rules: Rules, facts: DownloadFacts): Decision {
  if (facts.own) return { action: 'leave', reason: 'own' };
  const finalUrl = facts.finalUrl && downloadHost(facts.finalUrl) ? facts.finalUrl : facts.url;
  const host = downloadHost(finalUrl);
  if (!host) return { action: 'leave', reason: 'scheme' };
  const method = (facts.method ?? 'GET').toUpperCase();
  if (method === 'POST') {
    if (!facts.postBody) return { action: 'leave', reason: 'method' };
  } else if (method !== 'GET') {
    return { action: 'leave', reason: 'method' };
  }
  if (!rules.intercept) return { action: 'leave', reason: 'off' };
  if (facts.incognito && !rules.privateWindows) return { action: 'leave', reason: 'private' };
  if (
    (rules.bypassKey === 'alt' && facts.altKey) ||
    (rules.bypassKey === 'shift' && facts.shiftKey)
  ) {
    return { action: 'leave', reason: 'bypass' };
  }
  // A site rule matches the address that was started, the one it ended at, or the page it was started from.
  const hosts = [
    ...new Set(
      [
        downloadHost(facts.url),
        host,
        facts.pageUrl ? downloadHost(facts.pageUrl) : undefined,
      ].filter((value): value is string => value !== undefined),
    ),
  ];
  if (hosts.some((candidate) => listed(candidate, rules.excludedSites)))
    return { action: 'leave', reason: 'site' };
  if (hosts.some((candidate) => listed(candidate, rules.alwaysSites))) return { action: 'take' };
  if (facts.sizeBytes !== undefined && facts.sizeBytes < rules.minSizeBytes) {
    return { action: 'leave', reason: 'size' };
  }
  if (!typeAllowed(rules, facts, finalUrl)) return { action: 'leave', reason: 'type' };
  if (rules.askFirst) return { action: 'ask' };
  return { action: 'take' };
}
