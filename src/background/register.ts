import { listen, type RuntimeLike } from '../lib/bus/bus';
import type { LiveSnapshot } from '../lib/downloads/service';
import type { InterceptService, RequestEvent } from '../lib/intercept/service';
import type { LinksService } from '../lib/links/service';
import type { MediaService } from '../lib/media/service';
import { createHandlers } from './handlers';
import { createServices, type Environment } from './services';

/**
 * The one place where the background registers its listeners. It runs synchronously while the background script loads
 * (a service worker or event page that is woken by an event only delivers it to listeners registered by the end of the
 * first turn), and every listener reads what it needs from storage when it runs. New listeners (downloads, web requests,
 * alarms, context menus…) are added here, never inside a callback or after an `await`.
 */
export function registerBackground(
  runtime: RuntimeLike,
  env: Environment,
  lifecycle: Lifecycle,
): void {
  const services = createServices(env);
  listen(runtime, createHandlers(services), (type, error) => {
    services.log.warn('bus', `handler ${type} failed`, { error });
  });

  const check = (why: string) => {
    services.log.debug('connection', `check: ${why}`);
    void services.connection.refresh();
  };
  lifecycle.onStartup.addListener(() => check('startup'));
  lifecycle.onInstalled.addListener(() => {
    ensureAlarm(lifecycle.alarms);
    check('installed');
  });
  lifecycle.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHECK_ALARM) check('alarm');
  });
  // Alarms can be lost with the browser session: make sure ours exists whenever the background loads.
  ensureAlarm(lifecycle.alarms);
  if (services.intercept && lifecycle.intercept) {
    lifecycle.intercept.attach(services.intercept);
    void services.intercept.sweep();
  }
  if (services.links && lifecycle.menus) {
    lifecycle.menus.attach(services.links);
    void services.links.install();
  }
  if (services.media && lifecycle.media) lifecycle.media.attach(services.media);
  lifecycle.live?.onConnect.addListener((port) => {
    if (port.name !== 'downloads') return;
    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());
    void services.downloads.watch((snapshot) => port.postMessage(snapshot), controller.signal);
  });
  lifecycle.commands?.onCommand.addListener((command) => {
    if (command === 'toggle-intercept') {
      void services.settings.update((settings) => ({
        ...settings,
        rules: { ...settings.rules, intercept: !settings.rules.intercept },
      }));
    }
    if (command === 'open-options') void lifecycle.commands?.openOptions();
  });
}

/** The alarm that looks at the connection once a minute. */
export const CHECK_ALARM = 'connection-check';

/** The parts of `browser.runtime` and `browser.alarms` the background lifecycle uses. */
export interface Lifecycle {
  onStartup: { addListener(listener: () => void): void };
  onInstalled: { addListener(listener: () => void): void };
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  /**
   * Registers the download and webRequest listeners. Called synchronously, so an event that woke the worker is not
   * lost. Absent in tests that do not exercise interception.
   */
  intercept?: {
    attach(intercept: InterceptService): void;
  };
  /** Registers the context-menu listener synchronously, then the service fills the menus. */
  menus?: {
    attach(links: LinksService): void;
  };
  /** A second webRequest listener for the media list. Registered with the others, before any await. */
  media?: {
    attach(media: MediaService): void;
  };
  /** The popup connects here while it is open so the event stream can stop when it closes. */
  live?: {
    onConnect: {
      addListener(listener: (port: LivePort) => void): void;
    };
  };
  commands?: {
    onCommand: { addListener(listener: (command: string) => void): void };
    openOptions(): void;
  };
}

interface LivePort {
  name: string;
  postMessage(message: LiveSnapshot): void;
  onDisconnect: { addListener(listener: () => void): void };
}

/** Addresses the hand-off watches. `blob:` and `data:` are not among them. */
export const INTERCEPT_URLS = ['http://*/*', 'https://*/*', 'ftp://*/*'] as const;

/** The listener shape `browser.webRequest` and `browser.downloads` share, narrowed to what E2 registers. */
export interface InterceptBrowser {
  downloads: {
    onCreated: { addListener(listener: (item: RawDownload) => void): void };
  };
  webRequest: {
    onBeforeSendHeaders: WebListener;
    onHeadersReceived: WebListener;
  };
  windows: {
    onRemoved: { addListener(listener: (windowId: number) => void): void };
  };
}

interface WebListener {
  addListener(
    listener: (details: RawRequest) => void | Promise<{ cancel?: boolean } | void>,
    filter: { urls: string[] },
    extra: readonly string[],
  ): void;
}

/** The download item fields the hand-off reads. Both browsers provide these; Firefox leaves two of them empty. */
export interface RawDownload {
  id: number;
  url: string;
  finalUrl?: string | undefined;
  referrer?: string | undefined;
  filename?: string | undefined;
  mime?: string | undefined;
  fileSize?: number | undefined;
  totalBytes?: number | undefined;
  incognito?: boolean | undefined;
  byExtensionId?: string | undefined;
}

/** The webRequest fields the hand-off reads. */
export interface RawRequest {
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  documentUrl?: string | undefined;
  initiator?: string | undefined;
  originUrl?: string | undefined;
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
  requestHeaders?: { name?: string | undefined; value?: string | undefined }[] | undefined;
  responseHeaders?: { name?: string | undefined; value?: string | undefined }[] | undefined;
}

/** The context-menu click, narrowed to the fields the links service reads. */
export interface MenuBrowser {
  onClicked: {
    addListener(
      listener: (
        info: {
          menuItemId: string | number;
          linkUrl?: string;
          srcUrl?: string;
          selectionText?: string;
          pageUrl?: string;
          checked?: boolean;
        },
        tab?: { id?: number },
      ) => void,
    ): void;
  };
}

/** Registers the menu listener while the background loads. The entries themselves are filled in afterwards. */
export function attachMenus(browser: MenuBrowser, links: LinksService): void {
  browser.onClicked.addListener((info, tab) => {
    void links.onClick({
      menuItemId: String(info.menuItemId),
      ...(info.linkUrl ? { linkUrl: info.linkUrl } : {}),
      ...(info.srcUrl ? { srcUrl: info.srcUrl } : {}),
      ...(info.selectionText ? { selectionText: info.selectionText } : {}),
      ...(info.pageUrl ? { pageUrl: info.pageUrl } : {}),
      ...(info.checked !== undefined ? { checked: info.checked } : {}),
      ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
    });
  });
}

/** Registers the media listener on the same webRequest events. It never cancels a request. */
export function attachMedia(browser: InterceptBrowser, media: MediaService): void {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const request = toRequest(details);
      const mime = headerValue(request.responseHeaders, 'content-type');
      const sizeBytes = contentLength(headerValue(request.responseHeaders, 'content-length'));
      void media.observe({
        url: request.url,
        tabId: request.tabId,
        ...(mime ? { mime } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(request.documentUrl ? { pageUrl: request.documentUrl } : {}),
      });
    },
    { urls: [...INTERCEPT_URLS] },
    ['responseHeaders'],
  );
}

function headerValue(
  headers: { name?: string | undefined; value?: string | undefined }[] | undefined,
  name: string,
): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === name)?.value;
}

function contentLength(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Registers the hand-off listeners. Firefox also asks to cancel attachments before they become downloads. */
export function attachIntercept(
  browser: InterceptBrowser,
  intercept: InterceptService,
  firefox: boolean,
): void {
  browser.downloads.onCreated.addListener((item) => {
    void intercept.onCreated(toDownload(item));
  });
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      void intercept.onBeforeSendHeaders(toRequest(details));
    },
    { urls: [...INTERCEPT_URLS] },
    ['requestHeaders'],
  );
  browser.webRequest.onHeadersReceived.addListener(
    (details) => intercept.onHeadersReceived(toRequest(details)),
    { urls: [...INTERCEPT_URLS] },
    firefox ? ['blocking', 'responseHeaders'] : ['responseHeaders'],
  );
  browser.windows.onRemoved.addListener((windowId) => {
    void intercept.onWindowRemoved(windowId);
  });
}

function toDownload(item: RawDownload) {
  const size =
    item.fileSize !== undefined && item.fileSize >= 0
      ? item.fileSize
      : item.totalBytes !== undefined && item.totalBytes >= 0
        ? item.totalBytes
        : undefined;
  return {
    id: item.id,
    url: item.url,
    incognito: item.incognito === true,
    ...(item.finalUrl ? { finalUrl: item.finalUrl } : {}),
    ...(item.referrer ? { referrer: item.referrer } : {}),
    ...(item.filename ? { filename: item.filename } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(size !== undefined ? { sizeBytes: size } : {}),
    ...(item.byExtensionId ? { byExtensionId: item.byExtensionId } : {}),
  };
}

function toRequest(details: RawRequest): RequestEvent {
  return {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    tabId: details.tabId,
    ...(details.documentUrl ? { documentUrl: details.documentUrl } : {}),
    ...(details.initiator || details.originUrl
      ? { initiator: details.initiator ?? details.originUrl }
      : {}),
    ...(details.incognito !== undefined ? { incognito: details.incognito } : {}),
    ...(details.cookieStoreId ? { cookieStoreId: details.cookieStoreId } : {}),
    ...(details.requestHeaders ? { requestHeaders: details.requestHeaders } : {}),
    ...(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {}),
  };
}

function ensureAlarm(alarms: Lifecycle['alarms']): void {
  void Promise.resolve(alarms.get(CHECK_ALARM)).then(async (existing) => {
    if (!existing) await alarms.create(CHECK_ALARM, { periodInMinutes: 1 });
  });
}
