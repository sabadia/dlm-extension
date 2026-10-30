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
  type DownloadOptions,
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
    started: [] as DownloadOptions[],
    failCancel: false,
    failErase: false,
  };
  const clock = { now: 10_000 };
  const notes: { id: string; title: string; message: string }[] = [];
  const windows: { url: string }[] = [];
  const removed: number[] = [];
  let stores: { id: string; tabIds: number[] }[] | undefined;
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
  let n = 0;
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
        return downloads.failErase ? Promise.reject(new Error('no')) : Promise.resolve([query.id]);
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
      ...(over.cookies?.stores ? {} : { stores: () => Promise.resolve(stores ?? []) }),
    },
    notifications: {
      create: (id, options) => {
        notes.push({ id, title: options.title, message: options.message });
      },
    },
    windows: {
      create: (info) => {
        windows.push({ url: info.url });
        return Promise.resolve({ id: 20 + windows.length - 1 });
      },
      remove: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
    },
    askUrl: (id) => `ask.html?id=${id}`,
    client: () => ({
      capture: (body) => {
        captured.push(body);
        return Promise.resolve({ task: { id: 't1' } });
      },
    }),
    now: () => clock.now,
    id: () => `id-${(n += 1)}`,
    ...over,
  });
  return {
    service,
    downloads,
    notes,
    windows,
    removed,
    clock,
    setStores: (next: typeof stores) => {
      stores = next;
    },
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
    harness.service.onBeforeSendHeaders({
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
    harness.service.onBeforeSendHeaders({
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
    expect(harness.windows).toEqual([{ url: 'ask.html?id=id-1' }]);
    expect(await harness.service.askView('id-1')).toEqual({
      name: 'archive.zip',
      host: 'files.example.test',
      purpose: 'ask',
    });
    await harness.service.choose('id-1', 'always');
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
    await browserChoice.service.choose('id-1', 'browser');
    expect(browserChoice.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);

    const closed = deps();
    closed.settingsState.current = {
      ...closed.settingsState.current,
      rules: { ...closed.settingsState.current.rules, askFirst: true },
    };
    await closed.service.onCreated(item());
    await closed.service.onWindowRemoved(20);
    expect(closed.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);
    expect(await closed.service.askView('id-1')).toBeNull();
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
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
    });
    await harness.service.onHeadersReceived(response({ url: ZIP }));
    await harness.service.onCreated(item());
    expect(harness.downloads.cancelled).toEqual([]);
  });
});

const asking = (harness: ReturnType<typeof deps>) => {
  harness.settingsState.current = {
    ...harness.settingsState.current,
    rules: { ...harness.settingsState.current.rules, askFirst: true },
  };
};

describe('InterceptService review fixes', () => {
  it('keeps every open prompt when a page starts two downloads at once', async () => {
    const harness = deps();
    asking(harness);
    await harness.service.onCreated(item({ id: 4, url: `${ZIP}?a`, finalUrl: `${ZIP}?a` }));
    await harness.service.onCreated(item({ id: 5, url: `${ZIP}?b`, finalUrl: `${ZIP}?b` }));
    expect(harness.windows).toHaveLength(2);
    expect(await harness.service.askView('id-1')).not.toBeNull();
    expect(await harness.service.askView('id-2')).not.toBeNull();
    await harness.service.choose('id-1', 'dlm');
    await harness.service.choose('id-2', 'browser');
    expect(harness.captured).toHaveLength(1);
    expect(harness.downloads.started).toEqual([{ url: `${ZIP}?b`, filename: 'archive.zip' }]);
    // Answered prompts are gone, and closing their windows undoes nothing.
    await harness.service.onWindowRemoved(20);
    expect(harness.downloads.started).toHaveLength(1);
  });

  it('closes a prompt nobody answered and gives the download to the browser, only when it is stale', async () => {
    const harness = deps();
    asking(harness);
    await harness.service.onCreated(item());
    await harness.service.sweep();
    expect(harness.removed).toEqual([]);
    harness.clock.now += 3 * 60_000;
    await harness.service.sweep();
    expect(harness.removed).toEqual([20]);
    expect(harness.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);
    expect(await harness.service.askView('id-1')).toBeNull();
  });

  it('treats a size of 0 as unknown, not as a small file', async () => {
    const harness = deps();
    await harness.service.onCreated(item({ sizeBytes: undefined }));
    expect(harness.captured).toHaveLength(1);
  });

  it('prefers the length of the response over an unknown size on the item', async () => {
    const harness = deps();
    harness.service.onBeforeSendHeaders({ requestId: 'r1', url: ZIP, method: 'GET', tabId: 3 });
    await harness.service.onHeadersReceived(
      response({
        url: ZIP,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/zip' },
          { name: 'Content-Length', value: '10' },
        ],
      }),
    );
    await harness.service.onCreated(item({ sizeBytes: undefined }));
    expect(harness.captured).toEqual([]); // 10 bytes is below the minimum
  });

  it('captures the download even when the cancelled entry cannot be erased', async () => {
    const harness = deps();
    harness.downloads.failErase = true;
    await harness.service.onCreated(item());
    expect(harness.captured).toHaveLength(1);
    expect(harness.downloads.started).toEqual([]);
  });

  it('leaves the download with the browser when it cannot be cancelled', async () => {
    const harness = deps();
    harness.downloads.failCancel = true;
    await harness.service.onCreated(item());
    expect(harness.captured).toEqual([]);
    expect(harness.downloads.started).toEqual([]);
  });

  it('gives the download back to the browser when the hand-off throws after the erase', async () => {
    const harness = deps({
      client: () => {
        throw new Error('unexpected');
      },
    });
    await harness.service.onCreated(item());
    expect(harness.downloads.erased).toEqual([4]);
    expect(harness.downloads.started).toEqual([{ url: ZIP, filename: 'archive.zip' }]);
  });

  it('takes a second download of the same address a minute later, as a request of its own', async () => {
    const harness = deps();
    for (const [index, requestId] of ['r1', 'r2'].entries()) {
      harness.service.onBeforeSendHeaders({ requestId, url: ZIP, method: 'GET', tabId: 3 });
      await harness.service.onHeadersReceived(response({ requestId, url: ZIP }));
      await harness.service.onCreated(item({ id: 4 + index }));
    }
    expect(harness.captured).toHaveLength(2);
    expect(harness.downloads.erased).toEqual([4, 5]);
  });

  it('leaves a restarted download alone for a minute, not for the rest of the session', async () => {
    const offline = deps({
      client: () => ({ capture: () => Promise.reject(new NetworkError('down')) }),
    });
    await offline.service.onCreated(item());
    expect(offline.downloads.started).toHaveLength(1);
    await offline.service.onCreated(item({ id: 8 }));
    expect(offline.downloads.cancelled).toEqual([4]); // the restart itself: left alone
    offline.clock.now += 61_000;
    await offline.service.onCreated(item({ id: 9 }));
    expect(offline.downloads.cancelled).toEqual([4, 9]);
  });

  it('applies site rules to the page the download started on', async () => {
    const harness = deps();
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, excludedSites: ['example.test'] },
    };
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://www.example.test/downloads',
    });
    await harness.service.onHeadersReceived(
      response({ url: ZIP, documentUrl: 'https://www.example.test/downloads' }),
    );
    await harness.service.onCreated(item());
    expect(harness.captured).toEqual([]); // files.example.test is a subdomain as well, so the page is not what decided
    const other = deps();
    other.settingsState.current = {
      ...other.settingsState.current,
      rules: { ...other.settingsState.current.rules, excludedSites: ['pages.test'] },
    };
    other.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: 'https://cdn.somewhere.test/a.zip',
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://pages.test/get',
    });
    await other.service.onHeadersReceived(
      response({ url: 'https://cdn.somewhere.test/a.zip', documentUrl: 'https://pages.test/get' }),
    );
    await other.service.onCreated(
      item({
        url: 'https://cdn.somewhere.test/a.zip',
        finalUrl: 'https://cdn.somewhere.test/a.zip',
      }),
    );
    expect(other.captured).toEqual([]);
  });

  it('remembers the page, not the CDN, when the answer is always for this site', async () => {
    const harness = deps();
    asking(harness);
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: 'https://cdn.random123.test/a.zip',
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://downloads.example.test/page',
    });
    await harness.service.onHeadersReceived(
      response({
        url: 'https://cdn.random123.test/a.zip',
        documentUrl: 'https://downloads.example.test/page',
      }),
    );
    await harness.service.onCreated(
      item({
        url: 'https://cdn.random123.test/a.zip',
        finalUrl: 'https://cdn.random123.test/a.zip',
      }),
    );
    expect((await harness.service.askView('id-1'))?.host).toBe('downloads.example.test');
    await harness.service.choose('id-1', 'always');
    expect(harness.settingsState.current.rules.alwaysSites).toEqual(['downloads.example.test']);
  });

  it('says it is a duplicate and adds it again when the notification is clicked', async () => {
    let calls = 0;
    const harness = deps({
      client: () => ({
        capture: (body) => {
          calls += 1;
          if ((body as { allowDuplicate?: boolean }).allowDuplicate) {
            return Promise.resolve({ task: { id: 't2' } });
          }
          return Promise.reject(new ApiError(409, 'task.duplicate', 'already there'));
        },
      }),
    });
    await harness.service.onCreated(item());
    const note = harness.notes[0];
    expect(note?.message).toContain('Click to add it again');
    expect(note?.id.startsWith('dlm-duplicate:')).toBe(true);
    expect(harness.downloads.started).toEqual([]); // not restarted in the browser
    expect(await harness.service.onNotificationClicked(note?.id ?? '')).toBe(true);
    expect(calls).toBe(2);
    expect(harness.notes.at(-1)?.message).toContain('archive.zip');
    // A second click, or someone else's notification, does nothing.
    expect(await harness.service.onNotificationClicked(note?.id ?? '')).toBe(true);
    expect(calls).toBe(2);
    expect(await harness.service.onNotificationClicked('other')).toBe(false);
  });

  it('does not repeat an Authorization header on a redirect to another origin, and invents no referrer', async () => {
    const harness = deps();
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: 'https://start.example.test/go',
      method: 'GET',
      tabId: 3,
      documentUrl: 'https://example.test/page',
      requestHeaders: [{ name: 'Authorization', value: 'Bearer abc' }],
    });
    await harness.service.onHeadersReceived(response({ url: 'https://cdn.other.test/a.zip' }));
    await harness.service.onCreated(
      item({ url: 'https://start.example.test/go', finalUrl: 'https://cdn.other.test/a.zip' }),
    );
    const body = harness.captured[0] as {
      headers?: Record<string, string>;
      referrer?: string;
      pageUrl?: string;
    };
    expect(body.headers?.authorization).toBeUndefined();
    expect(body.referrer).toBeUndefined();
    expect(body.pageUrl).toBe('https://example.test/page');
  });

  it('keeps the Authorization header when nothing redirected', async () => {
    const harness = deps();
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
      requestHeaders: [{ name: 'Authorization', value: 'Bearer abc' }],
    });
    await harness.service.onHeadersReceived(response({ url: ZIP }));
    await harness.service.onCreated(item());
    expect(
      (harness.captured[0] as { headers?: Record<string, string> }).headers?.authorization,
    ).toBe('Bearer abc');
  });

  it('reads the cookies of the private window store on Chrome, and none for the normal one', async () => {
    const harness = deps();
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, privateWindows: true },
    };
    harness.setStores([
      { id: '0', tabIds: [1] },
      { id: '1', tabIds: [3] },
    ]);
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
      incognito: true,
    });
    await harness.service.onHeadersReceived(response({ url: ZIP, incognito: true }));
    await harness.service.onCreated(item({ incognito: true }));
    expect(harness.cookieCalls().map((call) => call.query.storeId)).toEqual(['1', '1']);
  });

  it('restarts a private-window download in the same private window or container', async () => {
    const harness = deps({
      client: () => ({ capture: () => Promise.reject(new NetworkError('down')) }),
    });
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, privateWindows: true },
    };
    harness.service.onBeforeSendHeaders({
      requestId: 'r1',
      url: ZIP,
      method: 'GET',
      tabId: 3,
      incognito: true,
      cookieStoreId: 'firefox-private',
    });
    await harness.service.onHeadersReceived(
      response({ url: ZIP, incognito: true, cookieStoreId: 'firefox-private' }),
    );
    await harness.service.onCreated(item({ incognito: true }));
    expect(harness.downloads.started).toEqual([
      { url: ZIP, filename: 'archive.zip', incognito: true, cookieStoreId: 'firefox-private' },
    ]);
  });

  it('keeps only the newest requests in memory', async () => {
    const harness = deps();
    for (let i = 0; i < 400; i += 1) {
      harness.service.onBeforeSendHeaders({
        requestId: `q${i}`,
        url: `https://cdn.example.test/${i}.zip`,
        method: 'GET',
        tabId: 3,
        requestHeaders: [{ name: 'Accept-Language', value: 'xx' }],
      });
    }
    await harness.service.onHeadersReceived(
      response({ requestId: 'q0', url: 'https://cdn.example.test/0.zip' }),
    );
    await harness.service.onHeadersReceived(
      response({ requestId: 'q399', url: 'https://cdn.example.test/399.zip' }),
    );
    await harness.service.onCreated(
      item({
        id: 1,
        url: 'https://cdn.example.test/0.zip',
        finalUrl: 'https://cdn.example.test/0.zip',
      }),
    );
    await harness.service.onCreated(
      item({
        id: 2,
        url: 'https://cdn.example.test/399.zip',
        finalUrl: 'https://cdn.example.test/399.zip',
      }),
    );
    const [first, last] = harness.captured as { headers?: Record<string, string> }[];
    expect(first?.headers).toBeUndefined();
    expect(last?.headers).toEqual({ 'accept-language': 'xx' });
  });

  it('on Firefox lets a response that is not an attachment through without waiting', () => {
    const harness = deps({ firefox: true });
    const result = harness.service.onHeadersReceived(
      response({ responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] }),
    );
    expect(result).toBeUndefined();
  });
});

describe('InterceptService POST downloads', () => {
  const post = (body: string, contentType = 'application/x-www-form-urlencoded') => {
    const harness = deps();
    harness.service.onBeforeRequest({
      requestId: 'p1',
      url: ZIP,
      method: 'POST',
      tabId: 3,
      postBody: btoa(body),
    });
    harness.service.onBeforeSendHeaders({
      requestId: 'p1',
      url: ZIP,
      method: 'POST',
      tabId: 3,
      requestHeaders: [{ name: 'Content-Type', value: contentType }],
    });
    return harness;
  };

  it('replays a small form POST and sends its content type', async () => {
    const harness = post('id=7');
    await harness.service.onHeadersReceived(
      response({ requestId: 'p1', url: ZIP, method: 'POST' }),
    );
    await harness.service.onCreated(item());
    expect(harness.captured[0]).toMatchObject({
      method: 'POST',
      body: btoa('id=7'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  });

  it('keeps a POST in the browser when the response is not a download', async () => {
    const harness = post('user=a&password=b');
    await harness.service.onHeadersReceived(
      response({
        requestId: 'p1',
        url: ZIP,
        method: 'POST',
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'Content-Disposition', value: 'attachment; filename="a.zip"' },
        ],
      }),
    );
    // An attachment keeps its body (the page asked for a download) ...
    await harness.service.onCreated(item());
    expect(harness.captured).toHaveLength(1);
    // ... but a login form answered with a page is dropped before it is stored.
    const login = post('user=a&password=b');
    await login.service.onHeadersReceived(
      response({
        requestId: 'p1',
        url: ZIP,
        method: 'POST',
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      }),
    );
    await login.service.onCreated(item());
    expect(login.captured).toEqual([]); // a POST without a stored body stays with the browser
  });

  it('does not replay a multipart POST', async () => {
    const harness = post('--b--', 'multipart/form-data; boundary=b');
    await harness.service.onHeadersReceived(
      response({ requestId: 'p1', url: ZIP, method: 'POST' }),
    );
    await harness.service.onCreated(item());
    expect(harness.captured).toEqual([]);
    expect(harness.downloads.cancelled).toEqual([]);
  });

  it('restarts a POST in the browser as a POST when DLM cannot take it', async () => {
    const harness = post('id=7');
    harness.service.onBeforeRequest({
      requestId: 'p1',
      url: ZIP,
      method: 'POST',
      tabId: 3,
      postBody: btoa('id=7'),
    });
    const offline = deps({
      client: () => ({ capture: () => Promise.reject(new NetworkError('down')) }),
    });
    offline.service.onBeforeRequest({
      requestId: 'p1',
      url: ZIP,
      method: 'POST',
      tabId: 3,
      postBody: btoa('id=7'),
    });
    offline.service.onBeforeSendHeaders({
      requestId: 'p1',
      url: ZIP,
      method: 'POST',
      tabId: 3,
      requestHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
    });
    await offline.service.onHeadersReceived(
      response({ requestId: 'p1', url: ZIP, method: 'POST' }),
    );
    await offline.service.onCreated(item());
    expect(offline.downloads.started).toEqual([
      {
        url: ZIP,
        filename: 'archive.zip',
        method: 'POST',
        body: 'id=7',
        headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      },
    ]);
  });
});

describe('InterceptService torrents', () => {
  const torrent = (outcome: 'taken' | 'duplicate' | 'failed') => {
    const calls: string[] = [];
    const harness = deps({
      torrents: {
        addTorrent: (facts) => {
          calls.push(facts.url);
          return Promise.resolve(outcome);
        },
      },
    });
    return { harness, calls };
  };
  const file = (over: Partial<DownloadSnapshot> = {}) =>
    item({
      url: 'https://files.example.test/a.torrent',
      finalUrl: 'https://files.example.test/a.torrent',
      filename: 'a.torrent',
      mime: 'application/x-bittorrent',
      ...over,
    });

  it('sends a torrent through the torrent upload', async () => {
    const { harness, calls } = torrent('taken');
    await harness.service.onCreated(file());
    expect(calls).toEqual(['https://files.example.test/a.torrent']);
    expect(harness.captured).toEqual([]);
  });

  it('says duplicate for a torrent DLM already has, and does not download it in the browser', async () => {
    const { harness } = torrent('duplicate');
    await harness.service.onCreated(file());
    expect(harness.downloads.started).toEqual([]);
    expect(harness.notes[0]?.message).toContain('Click to add it again');
  });

  it('gives a rejected torrent back to the browser', async () => {
    const { harness } = torrent('failed');
    await harness.service.onCreated(file());
    expect(harness.downloads.started).toHaveLength(1);
  });

  it('still uses the torrent upload after ask-first', async () => {
    const { harness, calls } = torrent('taken');
    asking(harness);
    await harness.service.onCreated(file());
    await harness.service.choose('id-1', 'dlm');
    expect(calls).toHaveLength(1);
  });

  it('captures a torrent from a private window with its own cookies instead of fetching it', async () => {
    const { harness, calls } = torrent('taken');
    harness.settingsState.current = {
      ...harness.settingsState.current,
      rules: { ...harness.settingsState.current.rules, privateWindows: true },
    };
    await harness.service.onCreated(file({ incognito: true }));
    expect(calls).toEqual([]);
    expect(harness.captured).toHaveLength(1);
  });
});
