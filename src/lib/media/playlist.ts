/** One quality of an HLS master playlist or a DASH manifest. */
export interface Variant {
  url: string;
  /** A short label such as `1080p` or `audio`. */
  quality: string;
  bandwidth?: number | undefined;
}

/**
 * Reads an HLS master playlist. A media playlist (no `#EXT-X-STREAM-INF`) has no variants: the file itself is the
 * download. Relative addresses are resolved against `base`.
 */
export function parseHls(text: string, base: string): Variant[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line?.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(i + 1).find((item) => item !== '' && !item.startsWith('#'));
    if (!next) continue;
    const url = resolve(next, base);
    if (!url) continue;
    const height = /RESOLUTION=\d+x(\d+)/i.exec(line)?.[1];
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1]);
    variants.push({
      url,
      quality: height ? `${height}p` : 'video',
      ...(Number.isFinite(bandwidth) ? { bandwidth } : {}),
    });
  }
  return variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

/**
 * Reads a DASH MPD. Each `Representation` with a `BaseURL` or the manifest's own URL becomes a variant. Height wins
 * as the label, then bandwidth.
 */
export function parseDash(text: string, base: string): Variant[] {
  const variants: Variant[] = [];
  const reps = text.split(/<Representation\b/i).slice(1);
  for (const rep of reps) {
    const height = /height="(\d+)"/i.exec(rep)?.[1];
    const bandwidth = Number(/bandwidth="(\d+)"/i.exec(rep)?.[1]);
    const baseUrl = /<BaseURL[^>]*>\s*([^<\s]+)\s*<\/BaseURL>/i.exec(rep)?.[1];
    const url = baseUrl ? resolve(baseUrl, base) : base;
    if (!url) continue;
    const mime = /mimeType="([^"]+)"/i.exec(rep)?.[1] ?? '';
    variants.push({
      url,
      quality: height ? `${height}p` : mime.startsWith('audio/') ? 'audio' : 'video',
      ...(Number.isFinite(bandwidth) ? { bandwidth } : {}),
    });
  }
  return variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

function resolve(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}
