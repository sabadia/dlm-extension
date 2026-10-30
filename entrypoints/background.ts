import { browser } from 'wxt/browser';
import {
  attachIntercept,
  registerBackground,
  type InterceptBrowser,
} from '../src/background/register';
import { detectBrowser } from '../src/lib/pairing/browser';
import { originPattern } from '../src/lib/settings/url';
import { browserArea } from '../src/lib/storage/area';

export default defineBackground(() => {
  // Listeners are registered here, synchronously, and nothing that matters is kept in memory
  // (docs/CONVENTIONS.md, "Extension rules").
  const brave = 'brave' in navigator;
  const firefox = detectBrowser(navigator.userAgent, brave) === 'firefox';
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  registerBackground(
    browser.runtime,
    {
      local: browserArea(browser.storage.local),
      session: browserArea(browser.storage.session),
      version: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      brave,
      native: browser.runtime,
      action: browser.action,
      hasAccess: (baseUrl) => browser.permissions.contains({ origins: [originPattern(baseUrl)] }),
      extensionId: browser.runtime.id,
      extensionOrigin,
      firefox,
      iconUrl: browser.runtime.getURL('/icon.png'),
      downloads: {
        cancel: (id) => browser.downloads.cancel(id),
        erase: (query) => browser.downloads.erase(query),
        download: (options) => browser.downloads.download(options),
      },
      cookies: {
        getAll: (query) => browser.cookies.getAll(query),
      },
      notifications: {
        create: (id, options) =>
          browser.notifications.create(id, {
            type: 'basic',
            title: options.title,
            message: options.message,
            iconUrl: options.iconUrl ?? browser.runtime.getURL('/icon.png'),
          }),
      },
      windows: {
        create: async (info) => {
          const created = await browser.windows.create(info);
          return created?.id !== undefined ? { id: created.id } : {};
        },
      },
      askUrl: (id) => browser.runtime.getURL(`/ask.html?id=${encodeURIComponent(id)}`),
    },
    {
      onStartup: browser.runtime.onStartup,
      onInstalled: browser.runtime.onInstalled,
      alarms: browser.alarms,
      intercept: {
        attach: (intercept) =>
          attachIntercept(browser as unknown as InterceptBrowser, intercept, firefox),
      },
    },
  );
});
