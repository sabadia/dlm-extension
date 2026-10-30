import { browser } from 'wxt/browser';
import { isDirectScheme } from '../src/lib/links/classify';
import type { PageLink } from '../src/lib/links/filter';
import { sendMessage } from '../src/lib/bus/bus';

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
