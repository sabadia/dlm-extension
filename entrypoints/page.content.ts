import { browser } from 'wxt/browser';
import { sendMessage } from '../src/lib/bus/bus';
import { isDirectScheme } from '../src/lib/links/classify';
import type { PageLink } from '../src/lib/links/filter';
import type { PageSnapshot } from '../src/lib/media/page';
import { pageHints, type HintLink } from '../src/lib/page/hints';

/**
 * Collects the links and media on the page for the preview, and sends magnet and eD2K clicks straight to DLM so the
 * browser does not ask to open another application. The page cannot ask for anything else.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'links.collect'
      )
        return undefined;
      sendResponse(collect());
      return true;
    });
    let protectedMedia = false;
    const schedule = debounce(() => {
      void sendMessage(browser.runtime, 'media.scan', {
        snapshot: snapshot(protectedMedia),
        visible: document.visibilityState === 'visible',
      }).catch(() => undefined);
      void sendMessage(browser.runtime, 'page.hints', { hints: pageHints(hintLinks()) }).catch(
        () => undefined,
      );
    });
    document.addEventListener(
      'encrypted',
      () => {
        protectedMedia = true;
        schedule();
      },
      true,
    );
    schedule();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href'],
    });
    window.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest('a');
        const href = anchor?.href;
        if (!href || !isDirectScheme(href)) return;
        event.preventDefault();
        event.stopPropagation();
        void sendMessage(browser.runtime, 'links.add', { url: href }).catch(() => undefined);
      },
      true,
    );
  },
});

function debounce(run: () => void): () => void {
  let pending = 0;
  return () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(run, 400);
  };
}

function snapshot(protectedMedia: boolean): PageSnapshot {
  const media = (selector: string) =>
    [...document.querySelectorAll(selector)].map((element) => ({
      src: element.getAttribute('src') ?? undefined,
      sources: [...element.querySelectorAll('source[src]')].map(
        (source) => source.getAttribute('src') ?? '',
      ),
    }));
  const videos = media('video');
  const blobOrMse = [...document.querySelectorAll('video')].some(
    (video) => video.currentSrc.startsWith('blob:') || video.srcObject !== null,
  );
  return {
    pageUrl: location.href,
    protectedMedia,
    blobOrMse,
    videos,
    audios: media('audio'),
    links: [...document.querySelectorAll('a[href]')].map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      text: anchor.textContent ?? '',
    })),
    openGraph: [
      ...document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]'),
    ]
      .map((meta) => meta.getAttribute('content') ?? '')
      .filter((url) => url !== ''),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => script.textContent ?? '',
    ),
  };
}

function hintLinks(): HintLink[] {
  const found: HintLink[] = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url: string;
    try {
      const parsed = new URL(anchor.getAttribute('href') ?? '', location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      url = parsed.href;
    } catch {
      continue;
    }
    const nearby = (anchor.parentElement?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 800);
    found.push({ url, text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(), nearby });
  }
  return found;
}

function collect(): PageLink[] {
  const found: PageLink[] = [];
  const push = (url: string | null, text: string, kind: PageLink['kind']) => {
    if (!url) return;
    try {
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ftp:')
        return;
      found.push({ url: parsed.href, text: text.trim() || parsed.href, kind });
    } catch {
      // Not an address.
    }
  };
  for (const anchor of document.querySelectorAll('a[href]')) {
    push(anchor.getAttribute('href'), anchor.textContent ?? '', 'link');
  }
  for (const kind of ['img', 'audio', 'video', 'source'] as const) {
    const media = kind === 'img' ? 'image' : kind === 'source' ? 'video' : kind;
    for (const element of document.querySelectorAll(`${kind}[src]`)) {
      push(element.getAttribute('src'), element.getAttribute('alt') ?? '', media);
    }
  }
  return found;
}
