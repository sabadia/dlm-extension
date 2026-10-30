import { browser } from 'wxt/browser';
import { sendMessage } from '../src/lib/bus/bus';

/**
 * Remembers Alt or Shift held at a click or key press, so the hand-off can leave that download in the browser.
 * The page cannot ask for anything else: the message carries only the two keys, and the background takes the tab
 * from the sender. Only real input counts (a page can dispatch fake events, which would keep its own downloads
 * in the browser), and every click is reported, so a modifier pressed a moment ago does not outlive its click.
 * It runs in every frame: a download link inside an iframe is clicked there.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const note = (alt: boolean, shift: boolean) => {
      void sendMessage(browser.runtime, 'gesture.note', { alt, shift }).catch(() => undefined);
    };
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.isTrusted && (event.altKey || event.shiftKey)) note(event.altKey, event.shiftKey);
      },
      true,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.isTrusted) note(event.altKey, event.shiftKey);
      },
      true,
    );
  },
});
