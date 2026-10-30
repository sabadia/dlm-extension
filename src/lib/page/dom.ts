import type { PageLink } from '../links/filter';
import type { PageSnapshot } from '../media/page';
import type { HintLink } from './hints';

/**
 * What the content script reads from a document. These are plain functions over a `Document`, so they are tested with
 * a DOM and the content script stays a thin shell. Everything is capped: a page can be as large and as hostile as it
 * likes, and the message to the background must not follow it.
 */

const MAX_MEDIA = 50;
const MAX_LINKS = 500;
const MAX_HINT_LINKS = 2000;
const MAX_TEXT = 200;
const MAX_JSON_LD = 10;
const MAX_JSON_LD_LENGTH = 20_000;

const clean = (text: string | null | undefined, max: number): string =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const attr = (element: Element, name: string): string | undefined =>
  element.getAttribute(name) ?? undefined;

/** The `mediaKeys` of a media element: set when it plays protected (EME) content. */
function hasMediaKeys(element: Element): boolean {
  return 'mediaKeys' in element && (element as HTMLMediaElement).mediaKeys != null;
}

/** True when a media element on the page already plays protected content (its `encrypted` event may have come early). */
export function pageIsProtected(doc: Document): boolean {
  return [...doc.querySelectorAll('video, audio')].some(hasMediaKeys);
}

function mediaElements(doc: Document, selector: string): PageSnapshot['videos'] {
  return [...doc.querySelectorAll(selector)].slice(0, MAX_MEDIA).map((element) => {
    const src = attr(element, 'src');
    return {
      ...(src !== undefined ? { src } : {}),
      sources: [...element.querySelectorAll('source[src]')]
        .slice(0, MAX_MEDIA)
        .map((source) => attr(source, 'src') ?? ''),
    };
  });
}

/** The title of a page: its `<title>`, else `og:title`, else its first `h1`. */
export function pageTitle(doc: Document): string {
  const title = clean(doc.title, MAX_TEXT);
  if (title) return title;
  const og = clean(
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    MAX_TEXT,
  );
  if (og) return og;
  return clean(doc.querySelector('h1')?.textContent, MAX_TEXT);
}

/** The media a document shows, without deciding what is worth listing. */
export function pageSnapshot(
  doc: Document,
  pageUrl: string,
  flags: { protectedMedia: boolean },
): PageSnapshot {
  const videos = [...doc.querySelectorAll('video')];
  return {
    pageUrl,
    title: pageTitle(doc),
    protectedMedia: flags.protectedMedia || pageIsProtected(doc),
    blobOrMse: videos.some(
      (video) => video.currentSrc.startsWith('blob:') || video.srcObject !== null,
    ),
    videos: mediaElements(doc, 'video'),
    audios: mediaElements(doc, 'audio'),
    links: [...doc.querySelectorAll('a[href]')].slice(0, MAX_LINKS).map((anchor) => ({
      href: attr(anchor, 'href') ?? '',
      text: clean(anchor.textContent, MAX_TEXT),
      ...(anchor.hasAttribute('download') ? { download: true } : {}),
    })),
    openGraph: [...doc.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]')]
      .slice(0, MAX_MEDIA)
      .map((meta) => attr(meta, 'content') ?? '')
      .filter((url) => url !== ''),
    jsonLd: [...doc.querySelectorAll('script[type="application/ld+json"]')]
      .slice(0, MAX_JSON_LD)
      .map((script) => (script.textContent ?? '').slice(0, MAX_JSON_LD_LENGTH)),
  };
}

/**
 * The text that belongs to one link: the closest list item, table row, paragraph or definition that holds only this
 * link, else the text after the link up to the next link. A hash printed next to another file's link is not this file's.
 */
export function nearbyText(anchor: Element): string {
  // A table row or list item outranks the cell inside it: the hash is usually in the next cell.
  const block = anchor.closest('tr, li, p, dd') ?? anchor.closest('td, dt');
  if (block && block.querySelectorAll('a[href]').length <= 1) {
    return clean(block.textContent, 800);
  }
  const parts: string[] = [];
  for (let node = anchor.nextSibling; node; node = node.nextSibling) {
    if (node instanceof Element && (node.matches('a[href]') || node.querySelector('a[href]')))
      break;
    parts.push(node.textContent ?? '');
    if (parts.join(' ').length > 400) break;
  }
  return clean(parts.join(' '), 400);
}

/** Web links with the text near them, for checksums and mirrors. */
export function hintLinks(doc: Document, base: string): HintLink[] {
  const found: HintLink[] = [];
  for (const anchor of [...doc.querySelectorAll('a[href]')].slice(0, MAX_HINT_LINKS)) {
    let url: string;
    try {
      const parsed = new URL(attr(anchor, 'href') ?? '', base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      url = parsed.href;
    } catch {
      continue;
    }
    found.push({ url, text: clean(anchor.textContent, MAX_TEXT), nearby: nearbyText(anchor) });
  }
  return found;
}

/** Every address the "download all links" page can offer: links, images, audio and video. */
export function pageLinks(doc: Document, base: string): PageLink[] {
  const found: PageLink[] = [];
  const push = (raw: string | null, text: string, kind: PageLink['kind']) => {
    if (!raw) return;
    try {
      const parsed = new URL(raw, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ftp:')
        return;
      found.push({ url: parsed.href, text: clean(text, MAX_TEXT) || parsed.href, kind });
    } catch {
      // Not an address.
    }
  };
  for (const anchor of doc.querySelectorAll('a[href]')) {
    push(anchor.getAttribute('href'), anchor.textContent ?? '', 'link');
  }
  for (const [selector, kind] of [
    ['img[src]', 'image'],
    ['audio[src]', 'audio'],
    ['video[src]', 'video'],
    ['source[src]', 'video'],
  ] as const) {
    for (const element of doc.querySelectorAll(selector)) {
      push(element.getAttribute('src'), element.getAttribute('alt') ?? '', kind);
    }
  }
  return found;
}

/** The magnet or eD2K address of a click, or undefined. Only a real click with the main button counts. */
export function directLinkOfClick(
  event: Pick<MouseEvent, 'isTrusted' | 'button' | 'target'>,
  isDirect: (url: string) => boolean,
): string | undefined {
  if (!event.isTrusted || event.button !== 0) return undefined;
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  const href = target.closest('a')?.href;
  return href && isDirect(href) ? href : undefined;
}

/**
 * Runs `run` at most once per `interval` milliseconds while `trigger` is called. The first call runs after a short wait
 * and a call during the wait is folded into it; a page that changes all the time is scanned every `interval`, not never.
 */
export function throttled(
  run: () => void,
  interval: number,
  timers: Pick<typeof globalThis, 'setTimeout'> = globalThis,
): () => void {
  let waiting = false;
  let dirty = false;
  const fire = () => {
    run();
    waiting = true;
    timers.setTimeout(() => {
      waiting = false;
      if (dirty) {
        dirty = false;
        fire();
      }
    }, interval);
  };
  return () => {
    if (waiting) {
      dirty = true;
      return;
    }
    waiting = true;
    timers.setTimeout(fire, 100);
  };
}
