import { classifyNetwork, nameOf, type MediaKind } from './classify';

/** What the content script can see without deciding what is media. */
export interface PageSnapshot {
  pageUrl: string;
  /** True when a media element fired `encrypted` or already has MediaKeys. */
  protectedMedia: boolean;
  /** True when a video is a blob URL or is fed by MediaSource. */
  blobOrMse: boolean;
  videos: { src?: string | undefined; sources: string[] }[];
  audios: { src?: string | undefined; sources: string[] }[];
  links: { href: string; text: string }[];
  openGraph: string[];
  jsonLd: string[];
}

export interface PageMedia {
  url: string;
  kind: MediaKind;
  name: string;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
}

/** The media a page scan should offer. Blob and data addresses are left out: the daemon cannot fetch them. */
export function mediaFromPage(snapshot: PageSnapshot): PageMedia[] {
  const found: PageMedia[] = [];
  const push = (raw: string | undefined, fallbackKind: MediaKind) => {
    const url = absolute(raw, snapshot.pageUrl);
    if (!url) return;
    const classified = classifyNetwork({ url });
    if (classified && !classified.manifestUrl) {
      found.push(toPage(classified));
      return;
    }
    if (isFileLink(url)) found.push({ url, kind: fallbackKind, name: nameOf(url) });
  };
  for (const video of snapshot.videos ?? []) {
    push(video.src, 'video');
    for (const source of video.sources) push(source, 'video');
  }
  for (const audio of snapshot.audios ?? []) {
    push(audio.src, 'audio');
    for (const source of audio.sources) push(source, 'audio');
  }
  for (const link of snapshot.links ?? []) push(link.href, 'file');
  for (const url of snapshot.openGraph ?? []) push(url, 'video');
  for (const block of snapshot.jsonLd ?? []) {
    for (const url of jsonLdContentUrls(block)) push(url, 'video');
  }
  const seen = new Set<string>();
  return found.filter((item) => (seen.has(item.url) ? false : (seen.add(item.url), true)));
}

function toPage(item: {
  url: string;
  kind: MediaKind;
  name: string;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
}): PageMedia {
  return {
    url: item.url,
    kind: item.kind,
    name: item.name,
    ...(item.mime ? { mime: item.mime } : {}),
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
  };
}

function absolute(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ftp:')
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

const FILE_EXT = /\.(mp4|webm|mkv|mp3|m4a|flac|m3u8|mpd|zip|pdf|7z)(\?|$)/i;

function isFileLink(url: string): boolean {
  return FILE_EXT.test(url);
}

/** `contentUrl` values of VideoObject / AudioObject blocks. Invalid JSON is ignored. */
export function jsonLdContentUrls(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    const urls: string[] = [];
    walk(parsed, urls);
    return urls;
  } catch {
    return [];
  }
}

function walk(value: unknown, urls: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, urls);
    return;
  }
  const record = value as Record<string, unknown>;
  const content = record.contentUrl;
  if (typeof content === 'string') urls.push(content);
  for (const child of Object.values(record)) walk(child, urls);
}

const MAX_ITEMS = 200;
const MAX_URL = 4096;
const MAX_TEXT = 300;
const MAX_JSON_LD = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).flatMap((item) => {
    const s = text(item, max);
    return s === undefined ? [] : [s];
  });
}

function elements(value: unknown): { src?: string | undefined; sources: string[] }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const src = text(item.src, MAX_URL);
    return [{ ...(src !== undefined ? { src } : {}), sources: strings(item.sources, MAX_URL) }];
  });
}

/**
 * Reads what a content script sent. The page can make its content script say anything, so every field is checked and
 * capped here: the caller supplies the page address (from the sender), never the snapshot.
 */
export function parseSnapshot(value: unknown, pageUrl: string): PageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const links = Array.isArray(value.links)
    ? value.links.slice(0, MAX_ITEMS * 5).flatMap((link) => {
        if (!isRecord(link)) return [];
        const href = text(link.href, MAX_URL);
        return href === undefined ? [] : [{ href, text: text(link.text, MAX_TEXT) ?? '' }];
      })
    : [];
  return {
    pageUrl,
    protectedMedia: value.protectedMedia === true,
    blobOrMse: value.blobOrMse === true,
    videos: elements(value.videos),
    audios: elements(value.audios),
    links,
    openGraph: strings(value.openGraph, MAX_URL),
    jsonLd: strings(value.jsonLd, MAX_JSON_LD),
  };
}
