import { browser } from 'wxt/browser';
import { sendMessage } from '../src/lib/bus/bus';
import { isDirectScheme } from '../src/lib/links/classify';
import {
  directLinkOfClick,
  hintLinks,
  pageIsProtected,
  pageLinks,
  pageSnapshot,
  throttled,
} from '../src/lib/page/dom';
import { pageHints } from '../src/lib/page/hints';

/** How often a page that keeps changing is looked at again. */
const SCAN_INTERVAL_MS = 2000;

/**
 * Collects the links and media on the page for the preview, tells the background about protected media, and sends
 * magnet and eD2K clicks straight to DLM so the browser does not ask to open another application. It runs in every
 * frame (a player is often an iframe); only the top frame reports links, media and hints. The page cannot ask for
 * anything else: the background checks the frame and the sender of every message.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  // The `encrypted` event of an autoplaying protected video fires before the page is idle.
  runAt: 'document_start',
  main() {
    const top = window === window.top;
    let protectedMedia = false;
    let reportedProtected = false;

    const reportProtected = () => {
      protectedMedia = true;
      if (!top && !reportedProtected) {
        reportedProtected = true;
        void sendMessage(browser.runtime, 'media.protected').catch(() => undefined);
      }
    };
    document.addEventListener(
      'encrypted',
      () => {
        reportProtected();
        scan();
      },
      true,
    );

    if (!top) {
      // An iframe only says that it plays protected media.
      document.addEventListener('DOMContentLoaded', () => {
        if (pageIsProtected(document)) reportProtected();
      });
      return;
    }

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'links.collect'
      )
        return undefined;
      sendResponse(pageLinks(document, location.href));
      return true;
    });

    const scan = throttled(() => {
      void sendMessage(browser.runtime, 'media.scan', {
        snapshot: pageSnapshot(document, location.href, { protectedMedia }),
      }).catch(() => undefined);
      void sendMessage(browser.runtime, 'page.hints', {
        hints: pageHints(hintLinks(document, location.href)),
      }).catch(() => undefined);
    }, SCAN_INTERVAL_MS);

    const start = () => {
      scan();
      new MutationObserver(scan).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'href'],
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.addEventListener(
      'click',
      (event) => {
        const href = directLinkOfClick(event, isDirectScheme);
        if (!href) return;
        // The browser would ask to open another application: stop it, and hand the link over. If DLM does not take
        // it, the browser gets it after all.
        event.preventDefault();
        event.stopPropagation();
        void sendMessage(browser.runtime, 'links.add', { url: href }).then(
          (accepted) => {
            if (!accepted) location.href = href;
          },
          () => {
            location.href = href;
          },
        );
      },
      true,
    );
  },
});
