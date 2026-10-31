import { listen, type RuntimeLike } from '../lib/bus/bus';
import { contentLength, headerValue, isAttachment } from '../lib/intercept/metadata';
import { responseSize } from '../lib/media/classify';
import { postBodyFrom } from '../lib/intercept/post';
import type { InterceptService, RequestEvent } from '../lib/intercept/service';
import type { LinksService } from '../lib/links/service';
import type { MediaService } from '../lib/media/service';
import { REFRESH_PERIOD_MINUTES } from '../lib/refresh/watch';
import { t } from '../lib/i18n';
import { createHandlers } from './handlers';
import type { Surface } from '../lib/settings/schema';
import { applySurface, onActionClicked, openSurface } from './surface';
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
  // The surface the settings choose, as far as this worker knows (see the open-files shortcut).
  let knownSurface: Surface | undefined;
  const applyChosen = services.applySurface;
  if (applyChosen) {
    services.applySurface = (chosen) => {
      knownSurface = chosen;
      return applyChosen(chosen);
    };
  }
  listen(runtime, createHandlers(services), (type, error) => {
    services.log.warn('bus', `handler ${type} failed`, { error });
  });

  const check = (why: string) => {
    services.log.debug('connection', `check: ${why}`);
    void (async () => {
      const before = await services.connection.get();
      const after = await services.connection.refresh();
      // The menus list the queues of DLM: build them again when DLM becomes reachable.
      if (after.kind === 'connected' && before.kind !== 'connected') void services.links?.install();
    })();
  };
  lifecycle.onStartup.addListener(() => {
    void services.links?.install();
    check('startup');
  });
  lifecycle.onInstalled.addListener((details) => {
    ensureAlarm(lifecycle.alarms);
    void services.links?.install();
    check('installed');
    // A new installation opens the setup; an update does not.
    if (details?.reason === 'install') lifecycle.commands?.openOptions();
  });
  lifecycle.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHECK_ALARM) {
      // A pairing the person approves after closing the options page is picked up here; the daemon revokes a token
      // nobody read within five minutes.
      void services.pairing
        .poll()
        .catch(() => undefined)
        .finally(() => check('alarm'));
      // A prompt nobody answered is settled here, not only when the worker happens to start.
      void services.intercept?.sweep();
    }
    if (alarm.name === REFRESH_ALARM) void services.refresh.scan();
  });
  // Alarms can be lost with the browser session: make sure ours exists whenever the background loads.
  ensureAlarm(lifecycle.alarms);
  if (services.intercept && lifecycle.intercept) {
    lifecycle.intercept.attach(services.intercept);
    void services.intercept.sweep();
  }
  // The menus are built when the extension is installed or the browser starts, not each time the worker wakes.
  if (services.links && lifecycle.menus) lifecycle.menus.attach(services.links);
  if (services.media && lifecycle.media) lifecycle.media.attach(services.media);
  // One listener for every notification that asks for a click: "already in DLM" (add it again), "link expired" (open
  // the page).
  lifecycle.notifications?.onClicked.addListener((id) => {
    void (async () => {
      if (await services.intercept?.onNotificationClicked(id)) return;
      await services.refresh.onNotificationClicked(id);
    })();
  });
  // Where the toolbar button opens the files: applied at every load, because the browser forgets the popup choice.
  const surface = env.surface;
  // The choice is kept here once known, so the shortcut can open the panel at once: both browsers only open one while
  // the key press is still being handled, and a storage read in between can be too late.
  if (surface) {
    void services.settings.get().then(
      (settings) => {
        knownSurface = settings.files.surface;
        return applySurface(surface, settings.files.surface);
      },
      (error: unknown) =>
        services.log.warn('surface', 'could not set the toolbar button', { error }),
    );
    // With no popup the button sends this event (Firefox: open the sidebar, which must happen in this call).
    lifecycle.action?.onClicked.addListener((tab) => {
      void onActionClicked(surface, tab?.id);
    });
  }
  lifecycle.tabs?.onRemoved.addListener((tabId) => {
    void services.media?.closed(tabId);
  });
  lifecycle.commands?.onCommand.addListener((command, tab) => {
    if (command === 'toggle-intercept') {
      void services.settings
        .update((settings) => ({
          ...settings,
          rules: { ...settings.rules, intercept: !settings.rules.intercept },
        }))
        .then(
          // The shortcut changes something the person cannot see: say what it is now.
          async (settings) => {
            await env.notifications?.create('dlm-toggle', {
              title: t('intercept.notify.title'),
              message: t(settings.rules.intercept ? 'intercept.toggledOn' : 'intercept.toggledOff'),
              ...(env.iconUrl ? { iconUrl: env.iconUrl } : {}),
            });
          },
        )
        .catch((error: unknown) => {
          services.log.warn('commands', 'could not toggle interception', { error });
        });
    }
    if (command === 'open-options') void lifecycle.commands?.openOptions();
    if (command === 'open-files' && surface) {
      const failed = (error: unknown) =>
        services.log.warn('commands', 'could not open the files', { error });
      if (knownSurface) {
        void openSurface(surface, knownSurface, tab?.id).catch(failed);
      } else {
        void services.settings
          .get()
          .then((settings) => openSurface(surface, settings.files.surface, tab?.id))
          .catch(failed);
      }
    }
  });
}

/** The alarm that looks at the connection once a minute. */
export const CHECK_ALARM = 'connection-check';

/** The alarm that looks for expired links. Half a minute: the worker does not stay awake for a stream. */
export const REFRESH_ALARM = 'link-refresh';

/** The parts of `browser.runtime` and `browser.alarms` the background lifecycle uses. */
export interface Lifecycle {
  onStartup: { addListener(listener: () => void): void };
  onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
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
  /** The toolbar button, when it has no popup. */
  action?: {
    onClicked: { addListener(listener: (tab?: { id?: number | undefined }) => void): void };
  };
  notifications?: {
    onClicked: { addListener(listener: (notificationId: string) => void): void };
  };
  /** A closed tab's media list is forgotten. */
  tabs?: {
    onRemoved: { addListener(listener: (tabId: number) => void): void };
  };
  commands?: {
    onCommand: {
      addListener(listener: (command: string, tab?: { id?: number | undefined }) => void): void;
    };
    openOptions(): void;
  };
}

/** Addresses the hand-off watches. `blob:` and `data:` are not among them. */
export const INTERCEPT_URLS = ['http://*/*', 'https://*/*'] as const;

/**
 * Request types the hand-off watches: navigations (a link to a file) and `other` (`<a download>`, `downloads.download`).
 * Images, scripts and XHR are never downloads, and watching them would run the listeners for every subresource.
 */
export const INTERCEPT_TYPES = ['main_frame', 'sub_frame', 'other'] as const;

/** The listener shape `browser.webRequest` and `browser.downloads` share, narrowed to what E2 registers. */
export interface InterceptBrowser {
  downloads: {
    onCreated: { addListener(listener: (item: RawDownload) => void): void };
  };
  webRequest: {
    onBeforeRequest: WebListener;
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
    filter: { urls: string[]; types?: string[] },
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
  /** `main_frame`, `sub_frame`, `xmlhttprequest`, `media`, … */
  type?: string | undefined;
  statusCode?: number | undefined;
  documentUrl?: string | undefined;
  initiator?: string | undefined;
  originUrl?: string | undefined;
  incognito?: boolean | undefined;
  cookieStoreId?: string | undefined;
  requestHeaders?: { name?: string | undefined; value?: string | undefined }[] | undefined;
  responseHeaders?: { name?: string | undefined; value?: string | undefined }[] | undefined;
  requestBody?:
    | {
        raw?: { bytes?: ArrayBuffer }[] | undefined;
        formData?: Record<string, string[]> | undefined;
      }
    | undefined;
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
        tab?: { id?: number; title?: string },
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
      ...(tab?.title ? { tabTitle: tab.title } : {}),
    });
  });
}

/**
 * Registers the media listener on the same webRequest events. It never cancels a request. A top-level navigation clears
 * the tab's list (Chrome does not tell a request which document made it, so the navigation itself is the signal); every
 * other response is offered to the classifier.
 */
export function attachMedia(browser: InterceptBrowser, media: MediaService): void {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const request = toRequest(details);
      if (details.type === 'main_frame') {
        // A link that answers with a download (or with nothing) does not leave the page: its media stays.
        const status = details.statusCode ?? 200;
        const leaves =
          status >= 200 &&
          status < 300 &&
          status !== 204 &&
          status !== 205 &&
          !isAttachment(headerValue(request.responseHeaders, 'content-disposition'));
        if (leaves) void media.navigated(request.tabId, request.url);
        return;
      }
      const mime = headerValue(request.responseHeaders, 'content-type');
      const sizeBytes = responseSize({
        status: details.statusCode,
        contentLength: contentLength(headerValue(request.responseHeaders, 'content-length')),
        contentRange: headerValue(request.responseHeaders, 'content-range'),
      });
      void media.observe({
        url: request.url,
        tabId: request.tabId,
        ...(mime ? { mime } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
    },
    { urls: [...INTERCEPT_URLS] },
    ['responseHeaders'],
  );
}

/** Registers the hand-off listeners. Firefox also asks to cancel attachments before they become downloads. */
export function attachIntercept(
  browser: InterceptBrowser,
  intercept: InterceptService,
  firefox: boolean,
): void {
  const filter = { urls: [...INTERCEPT_URLS], types: [...INTERCEPT_TYPES] };
  browser.downloads.onCreated.addListener((item) => {
    void intercept.onCreated(toDownload(item));
  });
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.method === 'POST') intercept.onBeforeRequest(toRequest(details));
    },
    filter,
    ['requestBody'],
  );
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      intercept.onBeforeSendHeaders(toRequest(details));
    },
    filter,
    // Chrome hides `Referer` and a few other headers unless asked; Firefox has no such option and refuses it.
    firefox ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders'],
  );
  browser.webRequest.onHeadersReceived.addListener(
    (details) => intercept.onHeadersReceived(toRequest(details)),
    filter,
    firefox ? ['blocking', 'responseHeaders'] : ['responseHeaders'],
  );
  browser.windows.onRemoved.addListener((windowId) => {
    void intercept.onWindowRemoved(windowId);
  });
}

function toDownload(item: RawDownload) {
  // The browser reports 0 or -1 for a size it does not know (a chunked response): that is unknown, not an empty file.
  const size =
    item.fileSize !== undefined && item.fileSize > 0
      ? item.fileSize
      : item.totalBytes !== undefined && item.totalBytes > 0
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
  const postBody = postBodyFrom(details.requestBody);
  return {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    tabId: details.tabId,
    ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
    ...(details.documentUrl ? { documentUrl: details.documentUrl } : {}),
    ...(details.initiator || details.originUrl
      ? { initiator: details.initiator ?? details.originUrl }
      : {}),
    ...(details.incognito !== undefined ? { incognito: details.incognito } : {}),
    ...(details.cookieStoreId ? { cookieStoreId: details.cookieStoreId } : {}),
    ...(details.requestHeaders ? { requestHeaders: details.requestHeaders } : {}),
    ...(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {}),
    ...(postBody ? { postBody } : {}),
  };
}

function ensureAlarm(alarms: Lifecycle['alarms']): void {
  void ensureOne(alarms, CHECK_ALARM, 1);
  void ensureOne(alarms, REFRESH_ALARM, REFRESH_PERIOD_MINUTES);
}

function ensureOne(
  alarms: Lifecycle['alarms'],
  name: string,
  periodInMinutes: number,
): Promise<void> {
  return Promise.resolve(alarms.get(name)).then(async (existing) => {
    // An alarm left by an older version with another period is made again.
    const period = (existing as { periodInMinutes?: number } | undefined)?.periodInMinutes;
    if (!existing || (period !== undefined && period !== periodInMinutes)) {
      await alarms.create(name, { periodInMinutes });
    }
  });
}
