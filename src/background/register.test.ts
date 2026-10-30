import { describe, expect, it } from 'vitest';
import {
  attachIntercept,
  INTERCEPT_TYPES,
  type InterceptBrowser,
  type RawDownload,
  type RawRequest,
} from './register';
import type { InterceptService, RequestEvent } from '../lib/intercept/service';

type Extra = readonly string[];

interface Registered {
  listener: (details: RawRequest) => unknown;
  filter: { urls: string[]; types?: string[] };
  extra: Extra;
}

function fakeBrowser() {
  const listeners: {
    created?: (item: RawDownload) => void;
    body?: Registered;
    headers?: Registered;
    response?: Registered;
    closed?: (id: number) => void;
    clicked?: (id: string) => void;
  } = {};
  const record = (slot: 'body' | 'headers' | 'response') => ({
    addListener: (
      listener: (details: RawRequest) => unknown,
      filter: { urls: string[]; types?: string[] },
      extra: Extra,
    ) => {
      listeners[slot] = { listener, filter, extra };
    },
  });
  const browser: InterceptBrowser = {
    downloads: { onCreated: { addListener: (listener) => (listeners.created = listener) } },
    webRequest: {
      onBeforeRequest: record('body'),
      onBeforeSendHeaders: record('headers'),
      onHeadersReceived: record('response'),
    },
    windows: { onRemoved: { addListener: (listener) => (listeners.closed = listener) } },
    notifications: { onClicked: { addListener: (listener) => (listeners.clicked = listener) } },
  };
  return { browser, listeners };
}

function fakeService() {
  const seen: { name: string; arg: unknown }[] = [];
  const service = {
    onCreated: (arg: unknown) => {
      seen.push({ name: 'created', arg });
      return Promise.resolve();
    },
    onBeforeRequest: (arg: RequestEvent) => seen.push({ name: 'body', arg }),
    onBeforeSendHeaders: (arg: RequestEvent) => seen.push({ name: 'headers', arg }),
    onHeadersReceived: (arg: RequestEvent) => {
      seen.push({ name: 'response', arg });
      return { cancel: true as const };
    },
    onWindowRemoved: (arg: number) => {
      seen.push({ name: 'closed', arg });
      return Promise.resolve();
    },
    onNotificationClicked: (arg: string) => {
      seen.push({ name: 'clicked', arg });
      return Promise.resolve(true);
    },
  } as unknown as InterceptService;
  return { service, seen };
}

const details = (over: Partial<RawRequest> = {}): RawRequest => ({
  requestId: 'r1',
  url: 'https://example.test/a.zip',
  method: 'GET',
  tabId: 3,
  ...over,
});

describe('attachIntercept', () => {
  it('watches only navigations and other requests, and blocks only on Firefox', () => {
    const chrome = fakeBrowser();
    attachIntercept(chrome.browser, fakeService().service, false);
    for (const slot of ['body', 'headers', 'response'] as const) {
      expect(chrome.listeners[slot]?.filter.types).toEqual([...INTERCEPT_TYPES]);
      expect(chrome.listeners[slot]?.filter.urls).toEqual(['http://*/*', 'https://*/*']);
    }
    expect(chrome.listeners.response?.extra).toEqual(['responseHeaders']);
    expect(chrome.listeners.headers?.extra).toEqual(['requestHeaders', 'extraHeaders']);
    const firefox = fakeBrowser();
    attachIntercept(firefox.browser, fakeService().service, true);
    expect(firefox.listeners.response?.extra).toEqual(['blocking', 'responseHeaders']);
    expect(firefox.listeners.headers?.extra).toEqual(['requestHeaders']);
  });

  it('passes a response back to the browser as it is, so Firefox can cancel it', () => {
    const { browser, listeners } = fakeBrowser();
    const { service } = fakeService();
    attachIntercept(browser, service, true);
    expect(listeners.response?.listener(details())).toEqual({ cancel: true });
  });

  it('forwards downloads, window closings and notification clicks', () => {
    const { browser, listeners } = fakeBrowser();
    const { service, seen } = fakeService();
    attachIntercept(browser, service, false);
    listeners.created?.({ id: 1, url: 'https://example.test/a' });
    listeners.closed?.(5);
    listeners.clicked?.('n1');
    expect(seen.map((entry) => entry.name)).toEqual(['created', 'closed', 'clicked']);
  });

  it('reports an unknown download size as unknown', () => {
    const { browser, listeners } = fakeBrowser();
    const { service, seen } = fakeService();
    attachIntercept(browser, service, false);
    listeners.created?.({ id: 1, url: 'https://example.test/a', totalBytes: 0, fileSize: -1 });
    listeners.created?.({ id: 2, url: 'https://example.test/b', totalBytes: 0, fileSize: 2048 });
    const [first, second] = seen.map((entry) => entry.arg as { sizeBytes?: number });
    expect(first?.sizeBytes).toBeUndefined();
    expect(second?.sizeBytes).toBe(2048);
  });

  it('hands over the body of a POST only, as text, and a parsed form as a url-encoded body', () => {
    const { browser, listeners } = fakeBrowser();
    const { service, seen } = fakeService();
    attachIntercept(browser, service, false);
    listeners.body?.listener(
      details({ requestBody: { raw: [{ bytes: new Uint8Array([97]).buffer }] } }),
    );
    expect(seen).toEqual([]); // a GET never has its body cached
    listeners.body?.listener(details({ method: 'POST', requestBody: { formData: { id: ['7'] } } }));
    listeners.body?.listener(
      details({ method: 'POST', requestBody: { raw: [{ bytes: new Uint8Array([0xff]).buffer }] } }),
    );
    const bodies = seen.map((entry) => (entry.arg as RequestEvent).postBody);
    expect(bodies).toEqual([btoa('id=7'), undefined]);
  });
});
