import { browser } from 'wxt/browser';
import { registerBackground } from '../src/background/register';
import { originPattern } from '../src/lib/settings/url';
import { browserArea } from '../src/lib/storage/area';

export default defineBackground(() => {
  // Listeners are registered here, synchronously, and nothing that matters is kept in memory
  // (docs/CONVENTIONS.md, "Extension rules").
  registerBackground(
    browser.runtime,
    {
      local: browserArea(browser.storage.local),
      session: browserArea(browser.storage.session),
      version: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      brave: 'brave' in navigator,
      native: browser.runtime,
      action: browser.action,
      hasAccess: (baseUrl) => browser.permissions.contains({ origins: [originPattern(baseUrl)] }),
    },
    {
      onStartup: browser.runtime.onStartup,
      onInstalled: browser.runtime.onInstalled,
      alarms: browser.alarms,
    },
  );
});
