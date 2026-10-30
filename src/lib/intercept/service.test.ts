import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../api/errors';
import type { ConnectionState } from '../connection/state';
import { silentLog } from '../log/log';
import { defaultSettings, type Settings } from '../settings/schema';
import { memoryArea } from '../storage/area';
import { HANDOFF_COUNT_KEY } from './count';
import {
  InterceptService,
  type CookieQuery,
  type DownloadSnapshot,
  type InterceptDeps,
  type RequestEvent,
} from './service';

const ZIP = 'https://files.example.test/archive.zip';

function item(over: Partial<DownloadSnapshot> = {}): DownloadSnapshot {
  return {
    id: 4,
    url: ZIP,
    finalUrl: ZIP,
    filename: 'archive.zip',
    mime: 'application/zip',
    sizeBytes: 5_000_000,
    incognito: false,
    ...over,
  };
}

function deps(over: Partial<InterceptDeps> = {}) {
  const settingsState: { current: Settings } = { current: defaultSettings() };
  const downloads = {
    cancelled: [] as number[],
    erased: [] as number[],
    started: [] as { url: string; filename?: string | undefined }[],
    failCancel: false,
  };
  const notes: { title: string; message: string }[] = [];
  const windows: { url: string }[] = [];
  const captured: unknown[] = [];
  const cookies: { query: CookieQuery }[] = [];
  let cookieRows: { domain: string; name: string; value: string }[] = [
    { domain: '.example.test', name: 'sid', value: 'secret' },
    { domain: 'other.test', name: 'nope', value: 'x' },
  ];
  const connection: ConnectionState = {
    kind: 'connected',
    targetId: 'local',
    baseUrl: 'http://127.0.0.1:9',
    version: '0.6.0',
  };
  const service = new InterceptService({
    settings: {
      get: () => Promise.resolve(settingsState.current),
      update: (change) => {
        settingsState.current = change(settingsState.current);
        return Promise.resolve(settingsState.current);
      },
    },
    secrets: { get: () => Promise.resolve('dlmt_token') },
    connection: {
      get: () => Promise.resolve(connection),
      repaint: () => Promise.resolve(),
    },
    session: memoryArea(),
    log: silentLog,
    extensionId: 'ext',
    extensionOrigin: 'chrome-extension://ext',
    userAgent: 'TestAgent',
    firefox: false,
    downloads: {
      cancel: (id) => {
        downloads.cancelled.push(id);
        return downloads.failCancel ? Promise.reject(new Error('no')) : Promise.resolve();
      },
      erase: (query) => {
        downloads.erased.push(query.id);
        return Promise.resolve([query.id]);
      },
      download: (options) => {
        downloads.started.push(options);
        return Promise.resolve(9);
      },
    },
    cookies: {
      getAll: (query) => {
        cookies.push({ query });
        if (query.partitionKey) return Promise.reject(new Error('no partition'));
        return Promise.resolve(cookieRows);
      },
    },
    notifications: {
      create: (_id, options) => {
        notes.push({ title: options.title, message: options.message });
      },
    },
    windows: {
      create: (info) => {
        windows.push({ url: info.url });
        return Promise.resolve({ id: 20 });
      },
    },
    askUrl: (id) => `ask.html?id=${id}`,
    client: () => ({
      capture: (body) => {
        captured.push(body);
        return Promise.resolve({ task: { id: 't1' } });
      },
    }),
    now: () => 10_000,
    id: () => 'ask-1',
    ...over,
  });
  return {
    service,
    downloads,
    notes,
    windows,
    captured,
    settingsState,
    cookieCalls: () => cookies,
    setCookies: (rows: typeof cookieRows) => {
      cookieRows = rows;
    },
    setConnection: (next: ConnectionState) => {
      Object.assign(connection, next);
    },
  };
}

const response = (over: Partial<RequestEvent> = {}): RequestEvent => ({
  requestId: 'r1',
  url: 'https://cdn.example.test/archive.zip',
  method: 'GET',
  tabId: 3,
  documentUrl: 'https://example.test/page',
  responseHeaders: [
    { name: 'Content-Type', value: 'application/zip' },
    { name: 'Content-Length', value: '5000000' },
    { name: 'Content-Disposition', value: 'attachment; filename="archive.zip"' },
  ],
  ...over,
});

describe('InterceptService hand-off', () => {
  it("cancels, erases and captures a download, with only that host's cookies", async () => {
    const harness = deps();
    await harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://example.test/page',
      requestHeaders: [
        { name: 'Accept', value: 'application/zip' },
        { name: 'Cookie', value: 'sid=secret' },
        { name: 'User-Agent', value: 'RequestAgent' },
      ],
    });
    await harness.service.onHeadersReceived(response({ url: ZIP }));
    await harness.service.onCreated(item());
    expect(harness.downloads.cancelled).toEqual([4]);
    expect(harness.downloads.erased).toEqual([4]);
    expect(harness.downloads.started).toEqual([]);
    expect(harness.captured).toEqual([
      expect.objectContaining({
        url: ZIP,
        cookieScope: 'task',
        userAgent: 'RequestAgent',
        headers: { accept: 'application/zip' },
        pageUrl: 'https://example.test/page',
        cookies: [expect.objectContaining({ name: 'sid', value: 'secret' })],
      }),
    ]);
    const body = harness.captured[0] as {
      cookies: { name: string }[];
      headers: Record<string, string>;
    };
    expect(body.cookies.map((cookie) => cookie.name)).toEqual(['sid']);
    expect(body.headers.cookie).toBeUndefined();
    expect(harness.notes[0]?.message).toContain('archive.zip');
  });

  it('does not touch a download this extension started', async () => {
    const harness = deps();
    await harness.service.onCreated(item({ byExtensionId: 'ext' }));
    expect(harness.downloads.cancelled).toEqual([]);
    expect(harness.captured).toEqual([]);
  });

  it('leaves a small file and a blob address in the browser', async () => {
    const harness = deps();
    await harness.service.onCreated(item({ sizeBytes: 10 }));
    await harness.service.onCreated(
      item({ id: 5, url: 'blob:https://example.test/id', finalUrl: undefined }),
    );
    expect(harness.downloads.cancelled).toEqual([]);
  });

  it('restarts the download in the browser when DLM cannot be reached, and not when it is a duplicate', async () => {
    const offline = deps({
      client: () => ({
        capture: () => Promise.reject(new NetworkError('down')),
      }),
    });
    await offline.service.onCreated(item());
    expect(offline.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);
    expect(offline.notes[0]?.message).toContain('down');
    // The restarted download is recognised and left alone.
    await offline.service.onCreated(item({ id: 8, byExtensionId: 'ext' }));
    expect(offline.downloads.cancelled).toEqual([4]);

    const duplicate = deps({
      client: () => ({
        capture: () => Promise.reject(new ApiError(409, 'task.duplicate', 'already there')),
      }),
    });
    await duplicate.service.onCreated(item());
    expect(duplicate.downloads.started).toEqual([]);
    expect(duplicate.notes[0]?.message).toContain('already in DLM');
  });

  it('falls back when DLM is not connected', async () => {
    const harness = deps();
    harness.setConnection({ kind: 'app-not-running' });
    await harness.service.onCreated(item());
    expect(harness.captured).toEqual([]);
    expect(harness.downloads.started).toHaveLength(1);
    expect(harness.notes[0]?.message).toContain('not connected');
  });

  it('uses the webRequest page when Firefox has no referrer, and cancels an attachment it captured', async () => {
    const harness = deps({ firefox: true });
    await harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: 'https://start.example.test/go',
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://example.test/page',
      requestHeaders: [{ name: 'Referer', value: 'https://example.test/page' }],
    });
    const blocking = await harness.service.onHeadersReceived(
      response({ url: 'https://cdn.example.test/archive.zip' }),
    );
    expect(blocking).toEqual({ cancel: true });
    expect(harness.captured[0]).toMatchObject({
      url: 'https://start.example.test/go',
      finalUrl: 'https://cdn.example.test/archive.zip',
      referrer: 'https://example.test/page',
      pageUrl: 'https://example.test/page',
    });
    // A download entry that still appears is erased, not captured again.
    await harness.service.onCreated(
      item({
        url: 'https://cdn.example.test/archive.zip',
        finalUrl: undefined,
        referrer: undefined,
      }),
    );
    expect(harness.captured).toHaveLength(1);
    expect(harness.downloads.cancelled).toEqual([4]);
  });

  it('does not cancel a Firefox attachment DLM rejected, and lets the browser keep it', async () => {
    const harness = deps({
      firefox: true,
      client: () => ({ capture: () => Promise.reject(new NetworkError('down')) }),
    });
    const blocking = await harness.service.onHeadersReceived(response());
    expect(blocking).toBeUndefined();
    expect(harness.downloads.started).toEqual([]);
    await harness.service.onCreated(
      item({
        url: 'https://cdn.example.test/archive.zip',
        finalUrl: 'https://cdn.example.test/archive.zip',
      }),
    );
    expect(harness.downloads.cancelled).toEqual([]);
  });

  it('asks, then remembers always-for-this-site and sends the download', async () => {
    const harness = deps();
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, askFirst: true },
    };
    await harness.service.onCreated(item());
    expect(harness.downloads.cancelled).toEqual([4]);
    expect(harness.captured).toEqual([]);
    expect(harness.windows).toEqual([{ url: 'ask.html?id=ask-1' }]);
    expect(await harness.service.askView('ask-1')).toEqual({
      name: 'archive.zip',
      host: 'files.example.test',
      purpose: 'ask',
    });
    await harness.service.choose('ask-1', 'always');
    expect(harness.settingsState.current.rules.alwaysSites).toEqual(['files.example.test']);
    expect(harness.captured).toHaveLength(1);
  });

  it('sends an asked download to the browser when that is the choice, or when the window is closed', async () => {
    const browserChoice = deps();
    browserChoice.settingsState.current = {
      ...browserChoice.settingsState.current,
      rules: { ...browserChoice.settingsState.current.rules, askFirst: true },
    };
    await browserChoice.service.onCreated(item());
    await browserChoice.service.choose('ask-1', 'browser');
    expect(browserChoice.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);

    const closed = deps();
    closed.settingsState.current = {
      ...closed.settingsState.current,
      rules: { ...closed.settingsState.current.rules, askFirst: true },
    };
    await closed.service.onCreated(item());
    await closed.service.onWindowRemoved(20);
    expect(closed.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);
    expect(await closed.service.askView('ask-1')).toBeNull();
  });

  it('reads no cookies for a private window unless the person allowed it', async () => {
    const harness = deps();
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, privateWindows: true },
    };
    await harness.service.onCreated(item({ incognito: true }));
    expect(harness.captured).toHaveLength(1);
    const blocked = deps();
    await blocked.service.onCreated(item({ incognito: true }));
    expect(blocked.captured).toEqual([]);
    expect(blocked.cookieCalls()).toEqual([]);
  });

  it('counts a handed-off download for the badge', async () => {
    const area = memoryArea();
    const harness = deps({ session: area });
    await harness.service.onCreated(item());
    expect(await area.get(HANDOFF_COUNT_KEY)).toBe(1);
  });

  it('leaves the download when Alt was held in that tab', async () => {
    const harness = deps();
    await harness.service.noteGesture(3, true, false);
    await harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
    });
    await harness.service.onCreated(item());
    expect(harness.downloads.cancelled).toEqual([]);
  });
});
