/**
 * What a network response is, for the media list. Pure: no browser APIs. Segments are grouped under the manifest that
 * owns them and are not listed on their own. Ads, trackers and tiny files are left out.
 */

export type MediaKind = 'hls' | 'dash' | 'video' | 'audio' | 'file';

export interface NetworkHit {
  url: string;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  /** Other manifests already seen on this tab, newest last. */
  manifests?: readonly string[] | undefined;
}

export interface Classified {
  url: string;
  kind: MediaKind;
  name: string;
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  /** Set when this response is a segment of a manifest. The list shows the manifest, not the segment. */
  manifestUrl?: string | undefined;
}

/** Files smaller than this are ignored unless they are a playlist. */
export const TINY_BYTES = 100_000;

const PLAYLIST_EXT = new Set(['m3u8', 'mpd']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa']);

const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adnxs.com',
  'scorecardresearch.com',
  'taboola.com',
  'outbrain.com',
  'moatads.com',
  'adsrvr.org',
];

/** True for hosts that serve ads and trackers rather than the page's media. */
export function isTracker(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  return AD_HOSTS.some((ad) => host === ad || host.endsWith(`.${ad}`)) || host.startsWith('ads.');
}

/**
 * Classifies one response. Undefined means it does not belong in the media list (a page, an ad, a tiny file, or a
 * segment that has no manifest yet).
 */
export function classifyNetwork(hit: NetworkHit): Classified | undefined {
  if (isTracker(hit.url)) return undefined;
  const ext = extensionOf(hit.url);
  const mime = bareMime(hit.mime);
  const kind = kindOf(ext, mime);
  if (!kind) return undefined;
  const segment = isSegment(hit.url, ext);
  if (segment) {
    const manifest = matchManifest(hit.url, hit.manifests ?? []);
    if (!manifest) return undefined;
    return {
      url: hit.url,
      kind,
      name: nameOf(hit.url),
      manifestUrl: manifest,
      ...(mime ? { mime } : {}),
    };
  }
  if (
    kind !== 'hls' &&
    kind !== 'dash' &&
    hit.sizeBytes !== undefined &&
    hit.sizeBytes < TINY_BYTES
  ) {
    return undefined;
  }
  return {
    url: hit.url,
    kind,
    name: nameOf(hit.url),
    ...(mime ? { mime } : {}),
    ...(hit.sizeBytes !== undefined ? { sizeBytes: hit.sizeBytes } : {}),
  };
}

function kindOf(ext: string | undefined, mime: string | undefined): MediaKind | undefined {
  if (
    ext === 'm3u8' ||
    mime === 'application/vnd.apple.mpegurl' ||
    mime === 'application/x-mpegurl'
  )
    return 'hls';
  if (ext === 'mpd' || mime === 'application/dash+xml') return 'dash';
  if (ext && VIDEO_EXT.has(ext)) return 'video';
  if (ext && AUDIO_EXT.has(ext)) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (ext && SEGMENT_EXT.has(ext)) return 'video';
  return undefined;
}

function isSegment(url: string, ext: string | undefined): boolean {
  if (ext && SEGMENT_EXT.has(ext)) return true;
  return /\/(seg|segment|chunk)[-_]?\d+/i.test(url);
}

/** The manifest whose directory contains the segment, or the newest one on the same host. */
export function matchManifest(
  segmentUrl: string,
  manifests: readonly string[],
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(segmentUrl);
  } catch {
    return undefined;
  }
  const dir = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
  const sameDir = manifests.find((manifest) => {
    try {
      const other = new URL(manifest);
      const otherDir = other.pathname.slice(0, other.pathname.lastIndexOf('/') + 1);
      return (
        other.origin === parsed.origin && (dir.startsWith(otherDir) || otherDir.startsWith(dir))
      );
    } catch {
      return false;
    }
  });
  if (sameDir) return sameDir;
  return manifests.find((manifest) => {
    try {
      return new URL(manifest).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

export function extensionOf(url: string): string | undefined {
  try {
    const base = new URL(url).pathname.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return undefined;
    const ext = base.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
  } catch {
    return undefined;
  }
}

export function nameOf(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop();
    return base && base !== '' ? decodeURIComponent(base) : new URL(url).hostname;
  } catch {
    return 'media';
  }
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function bareMime(mime: string | undefined): string | undefined {
  const bare = mime?.split(';')[0]?.trim().toLowerCase();
  return bare || undefined;
}

export { PLAYLIST_EXT };
