import { browser } from 'wxt/browser';
import { sendMessage } from '../src/lib/bus/bus';

/**
 * Remembers Alt or Shift held at a click or key press, so the hand-off can leave that download in the browser.
 * The page cannot ask for anything else: the message carries only the two keys, and the background takes the tab
 * from the sender.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  main() {
    const note = (alt: boolean, shift: boolean) => {
      if (!alt && !shift) return;
      void sendMessage(browser.runtime, 'gesture.note', { alt, shift }).catch(() => undefined);
    };
    window.addEventListener('keydown', (event) => note(event.altKey, event.shiftKey), true);
    window.addEventListener('pointerdown', (event) => note(event.altKey, event.shiftKey), true);
  },
});
