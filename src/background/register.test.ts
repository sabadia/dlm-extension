import { describe, expect, it } from 'vitest';
import {
  attachIntercept,
  type InterceptBrowser,
  type RawDownload,
  type RawRequest,
} from './register';
import type { InterceptService } from '../lib/intercept/service';

function fakeBrowser() {
  const listeners: {
    created?: (item: RawDownload) => void;
    request?: (details: RawRequest) => void | Promise<void | { cancel?: boolean }>;
    response?: (details: RawRequest) => Promise<{ cancel?: boolean } | void> | void;
    responseExtra?: readonly string[];
    closed?: (id: number) => void;
  } = {};
  const browser: InterceptBrowser = {
    downloads: { onCreated: { addListener: (listener) => (listeners.created = listener) } },
    webRequest: {
      onBeforeRequest: { addListener: () => undefined },
      onBeforeSendHeaders: { addListener: (listener) => (listeners.request = listener) },
      onHeadersReceived: {
        addListener: (listener, _filter, extra) => {
          listeners.response = listener;
          listeners.responseExtra = extra;
        },
      },
    },
    windows: { onRemoved: { addListener: (listener) => (listeners.closed = listener) } },
  };
  return { browser, listeners };
}

describe('attachIntercept', () => {
  it('registers every listener at once, and blocks only on Firefox', () => {
    const seen: string[] = [];
    const intercept = {
      onCreated: () => {
        seen.push('created');
        return Promise.resolve();
      },
      onBeforeSendHeaders: () => {
        seen.push('request');
        return Promise.resolve();
      },
      onHeadersReceived: () => Promise.resolve({ cancel: true as const }),
      onWindowRemoved: () => {
        seen.push('closed');
        return Promise.resolve();
      },
    } as unknown as InterceptService;
    const chrome = fakeBrowser();
    attachIntercept(chrome.browser, intercept, false);
    chrome.listeners.created?.({ id: 1, url: 'https://example.test/a' });
    expect(chrome.listeners.responseExtra).toEqual(['responseHeaders']);
    const firefox = fakeBrowser();
    attachIntercept(firefox.browser, intercept, true);
    expect(firefox.listeners.responseExtra).toEqual(['blocking', 'responseHeaders']);
    expect(seen).toEqual(['created']);
  });
});
