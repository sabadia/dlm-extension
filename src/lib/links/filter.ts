import { fileExtension } from '../intercept/rules';

/** One address found on a page. */
export interface PageLink {
  url: string;
  text: string;
  kind: 'link' | 'image' | 'audio' | 'video';
  /** Bytes, when the page said. Absent when it did not. */
  sizeBytes?: number | undefined;
}

/** What the preview page lets the person narrow the list to. Empty lists mean no limit of that kind. */
export interface LinkFilter {
  /** Extensions without a dot. */
  extensions: string[];
  /** A regular expression matched against the address and the text. An invalid pattern matches nothing. */
  pattern: string;
  /** Drop a link whose known size is below this. An unknown size is kept. */
  minSizeBytes: number;
}

/** True when the pattern is not empty and is not a regular expression. */
export function patternRejected(pattern: string): boolean {
  const source = pattern.trim();
  if (source === '') return false;
  try {
    new RegExp(source);
    return false;
  } catch {
    return true;
  }
}

/** The links that pass every set filter. Order is kept. A link is listed once per address. */
export function filterLinks(links: readonly PageLink[], filter: LinkFilter): PageLink[] {
  const seen = new Set<string>();
  let pattern: RegExp | undefined;
  const source = filter.pattern.trim();
  if (source !== '') {
    try {
      pattern = new RegExp(source, 'i');
    } catch {
      return [];
    }
  }
  const extensions = new Set(filter.extensions.map((ext) => ext.toLowerCase()));
  const out: PageLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    if (extensions.size > 0 && !extensions.has(fileExtension(undefined, link.url) ?? '')) continue;
    if (pattern && !pattern.test(link.url) && !pattern.test(link.text)) continue;
    if (link.sizeBytes !== undefined && link.sizeBytes < filter.minSizeBytes) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out;
}

/** At most this many tasks in one batch. The daemon refuses more from an extension token. */
export const BATCH_LIMIT = 100;

/** Splits addresses into batches the daemon will accept. */
export function chunk<T>(items: readonly T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
