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
  /** The origin of the page that reported it. A hint is used only for downloads started from that origin. */
  origin: string;
  at: number;
}

/** How long a page's hints stay useful. */
export const HINT_TTL_MS = 10 * 60 * 1000;

const MAX_HINTS = 50;
const MAX_MIRRORS = 16;

// A hash is a whole run of hex digits: never the first part of a longer one, never the tail of a word.
const HEX = '(?<![a-f0-9])';
const END = '(?![a-f0-9])';
const LABELED = new RegExp(
  `(?:sha-?256)\\s*(?:sum|checksum|hash)?\\s*[:=]?\\s*${HEX}([a-f0-9]{64})${END}|(?:sha-?1)\\s*(?:sum|checksum|hash)?\\s*[:=]?\\s*${HEX}([a-f0-9]{40})${END}|(?:md-?5)\\s*(?:sum|checksum|hash)?\\s*[:=]?\\s*${HEX}([a-f0-9]{32})${END}`,
  'i',
);
// Without a label only the long hashes count: 32 hex digits are also ids, cache keys and colours.
const BARE = new RegExp(`${HEX}([a-f0-9]{64}|[a-f0-9]{40})${END}`, 'i');
const MIRROR = /\bmirrors?\b/i;

/** A hash written next to a link. A labelled hash wins over a bare one, and a longer hash wins over a shorter one. */
export function checksumIn(text: string): Checksum | undefined {
  const labeled = LABELED.exec(text);
  if (labeled?.[1]) return { algorithm: 'sha256', expected: labeled[1].toLowerCase() };
  if (labeled?.[2]) return { algorithm: 'sha1', expected: labeled[2].toLowerCase() };
  if (labeled?.[3]) return { algorithm: 'md5', expected: labeled[3].toLowerCase() };
  const hex = BARE.exec(text)?.[1]?.toLowerCase();
  if (!hex) return undefined;
  return hex.length === 64
    ? { algorithm: 'sha256', expected: hex }
    : { algorithm: 'sha1', expected: hex };
}

function fileName(url: string): string | undefined {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').toLowerCase();
    return base.includes('.') && base !== '.' ? base : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Links of a page indexed once, so that finding mirrors is not a scan of every link for every link. */
interface MirrorIndex {
  /** Links whose own text says "mirror". */
  labelled: HintLink[];
  /** Links by file name. */
  byName: Map<string, HintLink[]>;
  /** A page is a download page when a link says mirror, or one file is offered by more than one host. */
  downloadPage: boolean;
}

function indexLinks(links: readonly HintLink[]): MirrorIndex {
  const labelled: HintLink[] = [];
  const byName = new Map<string, HintLink[]>();
  for (const link of links) {
    if (MIRROR.test(link.text)) labelled.push(link);
    const name = fileName(link.url);
    if (name) byName.set(name, [...(byName.get(name) ?? []), link]);
  }
  const severalHosts = [...byName.values()].some(
    (group) => new Set(group.map((link) => hostOf(link.url))).size >= 2,
  );
  return { labelled, byName, downloadPage: labelled.length > 0 || severalHosts };
}

/** A download page: a link is labelled as a mirror, or one file is offered from more than one host. */
export function isMirrorPage(links: readonly HintLink[]): boolean {
  return indexLinks(links).downloadPage;
}

function mirrorsIn(primary: string, index: MirrorIndex): string[] {
  if (!index.downloadPage) return [];
  const name = fileName(primary);
  const host = hostOf(primary);
  const out: string[] = [];
  const add = (link: HintLink) => {
    if (out.length < MAX_MIRRORS && link.url !== primary && !out.includes(link.url))
      out.push(link.url);
  };
  // The same file on another host, then links that say they are mirrors.
  for (const link of name ? (index.byName.get(name) ?? []) : []) {
    if (hostOf(link.url) !== host) add(link);
  }
  for (const link of index.labelled) {
    if (name !== undefined && fileName(link.url) === name) add(link);
  }
  return out;
}

/** Other http(s) links to the same file, at most 16. Empty when the page does not look like a download page. */
export function mirrorsFor(primary: string, links: readonly HintLink[]): string[] {
  return mirrorsIn(primary, indexLinks(links));
}

/** One hint per link that has a checksum or, on a download page, mirror links. */
export function pageHints(links: readonly HintLink[]): PageHint[] {
  const index = indexLinks(links);
  const hints: PageHint[] = [];
  for (const link of links) {
    if (!/^https?:\/\//i.test(link.url)) continue;
    const checksum = checksumIn(`${link.text}\n${link.nearby}`);
    const mirrors = mirrorsIn(link.url, index);
    if (!checksum && mirrors.length === 0) continue;
    hints.push({
      url: link.url,
      ...(checksum ? { checksum } : {}),
      ...(mirrors.length > 0 ? { mirrors } : {}),
    });
    if (hints.length >= MAX_HINTS) break;
  }
  return hints;
}

function fresh(list: readonly StoredHint[], now: number): StoredHint[] {
  return list.filter((hint) => now - hint.at <= HINT_TTL_MS);
}

/** Replaces the hints of the same page and address, and drops ones that have expired. */
export function rememberPageHints(
  list: readonly StoredHint[],
  hints: readonly PageHint[],
  origin: string,
  now: number,
): StoredHint[] {
  const urls = new Set(hints.map((hint) => hint.url));
  const kept = fresh(list, now).filter((hint) => hint.origin !== origin || !urls.has(hint.url));
  return [...kept, ...hints.map((hint) => ({ ...hint, origin, at: now }))].slice(-MAX_HINTS);
}

/**
 * The newest hint whose address is one of `urls` and that the page of `origin` reported. A page can say anything about
 * any address, so a hint only counts for a download that started on the page that made it.
 */
export function hintFor(
  list: readonly StoredHint[],
  urls: readonly string[],
  origin: string | undefined,
  now: number,
): StoredHint | undefined {
  if (origin === undefined) return undefined;
  const wanted = new Set(urls);
  return fresh(list, now)
    .filter((hint) => hint.origin === origin && wanted.has(hint.url))
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
