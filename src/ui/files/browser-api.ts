import { browser } from 'wxt/browser';
import { sendMessage } from '../../lib/bus/bus';
import { probeFile, ProbeCache } from '../../lib/files/probe';
import { browserArea } from '../../lib/storage/area';
import type { FilesApi, TabInfo } from './api';

/** An address a person may be taken to: web pages only. */
const webPage = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * The tab the panel is about: the active tab of its window. A page opened as `sidepanel.html?tab=<id>` is about that tab
 * instead, which is how the panel is looked at and tested in an ordinary tab.
 */
async function activeTab(): Promise<TabInfo | undefined> {
  const wanted = Number(new URLSearchParams(location.search).get('tab'));
  const tab =
    Number.isInteger(wanted) && wanted > 0
      ? await browser.tabs.get(wanted).catch(() => undefined)
      : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined) return undefined;
  // Only Firefox has containers.
  const store = (tab as { cookieStoreId?: string }).cookieStoreId;
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    incognito: tab.incognito,
    ...(store ? { cookieStoreId: store } : {}),
  };
}

const cache = new ProbeCache(browserArea(browser.storage.session));

/** The real `FilesApi`: the browser's tabs and storage, and the background through the bus. */
export const browserFilesApi: FilesApi = {
  activeTab,
  subscribe(listener) {
    const changed = (_a?: unknown, change?: { status?: string; url?: string }) => {
      // A page that finished loading or moved on; every other tab update is noise.
      if (change === undefined || change.status === 'complete' || change.url !== undefined)
        listener();
    };
    browser.tabs.onActivated.addListener(listener);
    browser.tabs.onUpdated.addListener(changed);
    browser.windows.onFocusChanged.addListener(listener);
    return () => {
      browser.tabs.onActivated.removeListener(listener);
      browser.tabs.onUpdated.removeListener(changed);
      browser.windows.onFocusChanged.removeListener(listener);
    };
  },
  mediaList: (tabId) => sendMessage(browser.runtime, 'media.list', { tabId }),
  async probe(url, force) {
    if (!force) {
      const known = await cache.get(url);
      if (known) return known;
    }
    const result = await probeFile(url, { fetch: (input, init) => fetch(input, init) });
    // A network failure is not a verdict on the file: it is asked again next time.
    if (!(!result.ok && result.reason === 'network')) await cache.put(url, result);
    return result;
  },
  settings: () => sendMessage(browser.runtime, 'settings.get'),
  async saveFiles(files) {
    const current = await sendMessage(browser.runtime, 'settings.get');
    return sendMessage(browser.runtime, 'settings.save', {
      rules: current.rules,
      preferences: current.preferences,
      routes: current.routes,
      files,
    });
  },
  async connection() {
    const shown = await sendMessage(browser.runtime, 'connection.refresh');
    return { kind: shown.state.kind, text: shown.text };
  },
  queues: () => sendMessage(browser.runtime, 'media.queues'),
  download: (request) => sendMessage(browser.runtime, 'media.download', request),
  variants: (url) => sendMessage(browser.runtime, 'media.variants', { url }),
  cookiesPreview: (request) => sendMessage(browser.runtime, 'media.cookies.preview', request),
  sendCookies: (request) => sendMessage(browser.runtime, 'media.cookies.send', request),
  openSetup() {
    void browser.runtime.openOptionsPage();
  },
  openSettings() {
    void browser.runtime.openOptionsPage();
  },
  openPage(url) {
    if (webPage(url)) void browser.tabs.create({ url });
  },
  copy: (text) => navigator.clipboard.writeText(text),
};
