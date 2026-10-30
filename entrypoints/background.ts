import { browser } from 'wxt/browser';
import {
  attachIntercept,
  attachMedia,
  attachMenus,
  registerBackground,
  type InterceptBrowser,
  type MenuBrowser,
} from '../src/background/register';
import type { MenuSpec } from '../src/lib/links/menus';
import { detectBrowser } from '../src/lib/pairing/browser';
import { TORRENT_LIMIT } from '../src/lib/links/service';
import { originPattern } from '../src/lib/settings/url';
import { browserArea } from '../src/lib/storage/area';

/**
 * Reads a file with the cookies of the default profile, at most `limit` bytes: a refusal (403, an HTML error page) or a
 * file that is too large is an error, not something to upload.
 */
async function fetchLimited(url: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('The file is too large.');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('The file is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The side panel API of Chrome, when this browser has it. */
const chromeSidePanel = (
  globalThis as unknown as {
    chrome?: {
      sidePanel?: {
        setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
        open(options: { tabId: number }): Promise<void>;
      };
    };
  }
).chrome?.sidePanel;

/** The sidebar API of Firefox, when this browser has it. */
const firefoxSidebar = (
  globalThis as unknown as { browser?: { sidebarAction?: { open(): Promise<void> } } }
).browser?.sidebarAction;

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
        download: (options) =>
          browser.downloads.download({
            url: options.url,
            ...(options.filename ? { filename: options.filename } : {}),
            ...(options.method ? { method: options.method } : {}),
            ...(options.body !== undefined ? { body: options.body } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
            // Only Firefox keeps a download in the private window or container it started in.
            ...(firefox && options.incognito ? { incognito: true } : {}),
            ...(firefox && options.cookieStoreId ? { cookieStoreId: options.cookieStoreId } : {}),
          }),
      },
      cookies: {
        getAll: (query) => browser.cookies.getAll(query),
        // Firefox tells webRequest the cookie store itself; Chrome needs the stores and their tabs.
        ...(firefox
          ? {}
          : {
              stores: async () =>
                (await browser.cookies.getAllCookieStores()).map((store) => ({
                  id: store.id,
                  tabIds: store.tabIds,
                })),
            }),
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
      surface: {
        setPopup: (popup) => browser.action.setPopup({ popup }),
        // Chrome only: the side panel API. Firefox has `sidebarAction` instead.
        ...(chromeSidePanel
          ? {
              openPanelOnActionClick: (on: boolean) =>
                chromeSidePanel.setPanelBehavior({ openPanelOnActionClick: on }),
              openSidePanel: (tabId: number) => chromeSidePanel.open({ tabId }),
            }
          : {}),
        ...(firefoxSidebar ? { openSidebar: () => firefoxSidebar.open() } : {}),
        openPopup: () => browser.action.openPopup(),
      },
      open: async (url) => {
        await browser.tabs.create({ url });
      },
      windows: {
        create: async (info) => {
          const created = await browser.windows.create(info);
          return created?.id !== undefined ? { id: created.id } : {};
        },
        remove: (id) => browser.windows.remove(id),
      },
      askUrl: (id) => browser.runtime.getURL(`/ask.html?id=${encodeURIComponent(id)}`),
      menus: {
        removeAll: () => browser.contextMenus.removeAll(),
        create: (spec: MenuSpec) => {
          browser.contextMenus.create({
            id: spec.id,
            title: spec.title,
            contexts: spec.contexts as ['page'],
            ...(spec.parentId ? { parentId: spec.parentId } : {}),
            ...(spec.type === 'checkbox'
              ? { type: 'checkbox' as const, checked: spec.checked ?? false }
              : {}),
          });
        },
        update: async (id, change) => {
          await browser.contextMenus.update(id, change);
        },
        open: async (url) => {
          await browser.tabs.create({ url });
        },
      },
      linksUrl: (tabId) => browser.runtime.getURL(`/links.html?tab=${tabId}`),
      fetchFile: (url) => fetchLimited(url, TORRENT_LIMIT),
      fetchText: async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
    },
    {
      onStartup: browser.runtime.onStartup,
      onInstalled: browser.runtime.onInstalled,
      alarms: browser.alarms,
      intercept: {
        attach: (intercept) =>
          attachIntercept(browser as unknown as InterceptBrowser, intercept, firefox),
      },
      menus: {
        attach: (links) => attachMenus(browser.contextMenus as unknown as MenuBrowser, links),
      },
      media: {
        attach: (media) => attachMedia(browser as unknown as InterceptBrowser, media),
      },
      action: { onClicked: browser.action.onClicked },
      tabs: { onRemoved: browser.tabs.onRemoved },
      notifications: { onClicked: browser.notifications.onClicked },
      commands: {
        onCommand: browser.commands.onCommand,
        openOptions: () => {
          void browser.runtime.openOptionsPage();
        },
      },
    },
  );
});
