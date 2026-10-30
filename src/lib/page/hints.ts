/**
 * Checksums and mirror links read off a download page. The page only reports what it showed; the background decides
 * whether a checksum is sent (after the user reviews it) and whether mirrors are sent (only when that is turned on).
 */

export type ChecksumAlgorithm = 'md5' | 'sha1' | 'sha256';

export interface Checksum {
  algorithm: ChecksumAlgorithm;
  /** Lower-case hex. */
  expected: string;
}

export interface HintLink {
  url: string;
  text: string;
  /** Text of the element that contains the link, already shortened. */
  nearby: string;
}

export interface PageHint {
  url: string;
  checksum?: Checksum;
  mirrors?: string[];
}

export interface StoredHint extends PageHint {
  at: number;
}

/** How long a page's hints stay useful. */
export const HINT_TTL_MS = 10 * 60 * 1000;

const MAX_HINTS = 50;
const MAX_MIRRORS = 16;

const LABELED =
  /(?:sha-?256|sha256)\s*[:=]?\s*([a-f0-9]{64})|(?:sha-?1|sha1)\s*[:=]?\s*([a-f0-9]{40})|(?:md-?5|md5)\s*[:=]?\s*([a-f0-9]{32})/i;
const BARE = /\b([a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/i;
const MIRROR = /\bmirrors?\b/i;

/** A hash written next to a link. A labelled hash wins over a bare one, and a longer hash wins over a shorter one. */
export function checksumIn(text: string): Checksum | undefined {
  const labeled = LABELED.exec(text);
  if (labeled?.[1]) return { algorithm: 'sha256', expected: labeled[1].toLowerCase() };
  if (labeled?.[2]) return { algorithm: 'sha1', expected: labeled[2].toLowerCase() };
  if (labeled?.[3]) return { algorithm: 'md5', expected: labeled[3].toLowerCase() };
  const hex = BARE.exec(text)?.[1]?.toLowerCase();
  if (!hex) return undefined;
  if (hex.length === 64) return { algorithm: 'sha256', expected: hex };
  if (hex.length === 40) return { algorithm: 'sha1', expected: hex };
  return { algorithm: 'md5', expected: hex };
}

function fileName(url: string): string | undefined {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').toLowerCase();
    return base.includes('.') && base !== '.' ? base : undefined;
  } catch {
    return undefined;
  }
}

/** A download page: a link is labelled as a mirror, or the same file name is offered more than once. */
export function isMirrorPage(links: readonly HintLink[]): boolean {
  if (links.some((link) => MIRROR.test(link.text) || MIRROR.test(link.nearby))) return true;
  const counts = new Map<string, number>();
  for (const link of links) {
    const name = fileName(link.url);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 2);
}

/** Other http(s) links to the same file, at most 16. Empty when the page does not look like a download page. */
export function mirrorsFor(primary: string, links: readonly HintLink[]): string[] {
  if (!isMirrorPage(links)) return [];
  const name = fileName(primary);
  const out: string[] = [];
  for (const link of links) {
    if (out.length >= MAX_MIRRORS) break;
    if (link.url === primary || !/^https?:\/\//i.test(link.url)) continue;
    const labelled = MIRROR.test(link.text);
    const sameFile = name !== undefined && fileName(link.url) === name;
    if (!labelled && !sameFile) continue;
    if (!out.includes(link.url)) out.push(link.url);
  }
  return out;
}

/** One hint per link that has a checksum or, on a download page, mirror links. */
export function pageHints(links: readonly HintLink[]): PageHint[] {
  const hints: PageHint[] = [];
  for (const link of links) {
    if (!/^https?:\/\//i.test(link.url)) continue;
    const checksum = checksumIn(`${link.text}\n${link.nearby}`);
    const mirrors = mirrorsFor(link.url, links);
    if (!checksum && mirrors.length === 0) continue;
    hints.push({
      url: link.url,
      ...(checksum ? { checksum } : {}),
      ...(mirrors.length > 0 ? { mirrors } : {}),
    });
  }
  return hints.slice(0, MAX_HINTS);
}

function fresh(list: readonly StoredHint[], now: number): StoredHint[] {
  return list.filter((hint) => now - hint.at <= HINT_TTL_MS);
}

/** Replaces hints for the same address and drops ones that have expired. */
export function rememberPageHints(
  list: readonly StoredHint[],
  hints: readonly PageHint[],
  now: number,
): StoredHint[] {
  const urls = new Set(hints.map((hint) => hint.url));
  const kept = fresh(list, now).filter((hint) => !urls.has(hint.url));
  return [...kept, ...hints.map((hint) => ({ ...hint, at: now }))].slice(-MAX_HINTS);
}

/** The newest hint whose address is one of `urls`. */
export function hintFor(
  list: readonly StoredHint[],
  urls: readonly string[],
  now: number,
): StoredHint | undefined {
  const wanted = new Set(urls);
  return fresh(list, now)
    .filter((hint) => wanted.has(hint.url))
    .sort((a, b) => b.at - a.at)[0];
}

const ALGORITHMS = new Set<ChecksumAlgorithm>(['md5', 'sha1', 'sha256']);

function asChecksum(raw: unknown): Checksum | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const algorithm = (raw as { algorithm?: unknown }).algorithm;
  const expected = (raw as { expected?: unknown }).expected;
  if (typeof algorithm !== 'string' || !ALGORITHMS.has(algorithm as ChecksumAlgorithm))
    return undefined;
  if (typeof expected !== 'string' || !/^[a-f0-9]+$/.test(expected)) return undefined;
  const length = expected.length;
  if (algorithm === 'sha256' && length !== 64) return undefined;
  if (algorithm === 'sha1' && length !== 40) return undefined;
  if (algorithm === 'md5' && length !== 32) return undefined;
  return { algorithm: algorithm as ChecksumAlgorithm, expected };
}

/** Hints a content script may report. Anything else is dropped. */
export function acceptedHints(raw: unknown): PageHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: PageHint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 8192) continue;
    const checksum = asChecksum((item as { checksum?: unknown }).checksum);
    const mirrors = Array.isArray((item as { mirrors?: unknown }).mirrors)
      ? (item as { mirrors: unknown[] }).mirrors.filter(
          (mirror): mirror is string =>
            typeof mirror === 'string' && /^https?:\/\//i.test(mirror) && mirror.length < 8192,
        )
      : [];
    if (!checksum && mirrors.length === 0) continue;
    hints.push({
      url,
      ...(checksum ? { checksum } : {}),
      ...(mirrors.length > 0 ? { mirrors: mirrors.slice(0, MAX_MIRRORS) } : {}),
    });
  }
  return hints.slice(0, MAX_HINTS);
}
