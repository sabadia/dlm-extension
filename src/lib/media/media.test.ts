import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../connection/state';
import type { CookieQuery } from '../intercept/cookies';
import { silentLog } from '../log/log';
import { memoryArea } from '../storage/area';
import { canonicalUrl, classifyNetwork, isTracker, responseSize } from './classify';
import { jsonLdContentUrls, mediaFromPage, parseSnapshot } from './page';
import { MediaService } from './service';
import {
  addNetwork,
  emptyTab,
  limitTabs,
  MAX_ITEMS,
  MAX_TABS,
  parseTab,
  replacePage,
  tabCounts,
  type TabMedia,
} from './store';

describe('classifyNetwork', () => {
  it('keeps playlists and real media, and drops ads, tiny files and stray segments', () => {
    expect(
      classifyNetwork({ url: 'https://cdn.example.test/master.m3u8', sizeBytes: 200 })?.kind,
    ).toBe('hls');
    expect(
      classifyNetwork({
        url: 'https://cdn.example.test/manifest.mpd',
        mime: 'application/dash+xml',
      })?.kind,
    ).toBe('dash');
    expect(
      classifyNetwork({ url: 'https://cdn.example.test/a.mp4', sizeBytes: 5_000_000 })?.kind,
    ).toBe('video');
    expect(
      classifyNetwork({ url: 'https://cdn.example.test/tiny.mp4', sizeBytes: 1000 }),
    ).toBeUndefined();
    expect(isTracker('https://ads.doubleclick.net/pixel')).toBe(true);
    expect(
      classifyNetwork({ url: 'https://ads.doubleclick.net/a.mp4', sizeBytes: 9_000_000 }),
    ).toBeUndefined();
    expect(
      classifyNetwork({
        url: 'https://cdn.example.test/hls/seg-1.ts',
        manifests: ['https://cdn.example.test/hls/master.m3u8'],
      })?.manifestUrl,
    ).toBe('https://cdn.example.test/hls/master.m3u8');
    expect(classifyNetwork({ url: 'https://cdn.example.test/seg-1.ts' })).toBeUndefined();
  });

  it('puts every range of one file on one address, and sizes a partial response by its total', () => {
    expect(canonicalUrl('https://v.test/videoplayback?id=1&range=0-999&rn=3')).toBe(
      'https://v.test/videoplayback?id=1',
    );
    expect(canonicalUrl('https://v.test/a.mp4')).toBe('https://v.test/a.mp4');
    expect(
      responseSize({ status: 206, contentLength: 1024, contentRange: 'bytes 0-1023/9000000' }),
    ).toBe(9_000_000);
    expect(responseSize({ status: 206, contentLength: 1024 })).toBeUndefined();
    expect(responseSize({ status: 200, contentLength: 500 })).toBe(500);
    expect(responseSize({ contentRange: 'bytes 0-1/*' })).toBeUndefined();
  });
});

describe('page scan', () => {
  it('collects video, file links, open graph and JSON-LD, and skips blob addresses', () => {
    const items = mediaFromPage({
      pageUrl: 'https://example.test/watch',
      title: 'Watch',
      protectedMedia: false,
      blobOrMse: true,
      videos: [{ src: 'blob:https://example.test/id', sources: ['/clip.mp4'] }],
      audios: [],
      links: [{ href: 'https://files.example.test/a.zip', text: 'zip' }],
      openGraph: ['https://cdn.example.test/og.mp4'],
      jsonLd: ['{"@type":"VideoObject","contentUrl":"https://cdn.example.test/ld.webm"}'],
    });
    expect(items.map((item) => item.url)).toEqual([
      'https://example.test/clip.mp4',
      'https://files.example.test/a.zip',
      'https://cdn.example.test/og.mp4',
      'https://cdn.example.test/ld.webm',
    ]);
    expect(jsonLdContentUrls('not json')).toEqual([]);
  });

  it('checks and caps what a page sent, and takes the page address from the caller', () => {
    expect(parseSnapshot('nonsense', 'https://p.test/')).toBeUndefined();
    const snapshot = parseSnapshot(
      {
        pageUrl: 'https://victim.test/',
        protectedMedia: 'yes',
        videos: [{ src: 5, sources: ['a', 7] }, 'x'],
        links: Array.from({ length: 5000 }, () => ({
          href: 'https://a.test/x',
          text: 'y'.repeat(900),
        })),
        openGraph: ['https://a.test/og.mp4'],
        jsonLd: ['z'.repeat(50_000)],
      },
      'https://p.test/',
    );
    expect(snapshot?.pageUrl).toBe('https://p.test/');
    expect(snapshot?.protectedMedia).toBe(false);
    expect(snapshot?.videos).toEqual([{ sources: ['a'] }]);
    expect(snapshot?.links).toHaveLength(1000);
    expect(snapshot?.links[0]?.text).toHaveLength(300);
    expect(snapshot?.jsonLd[0]).toHaveLength(20_000);
  });
});

describe('tab store', () => {
  const row = (name: string, source: 'network' | 'page' = 'network') => ({
    url: `https://cdn.example.test/${name}`,
    kind: 'video' as const,
    name,
    source,
  });

  it('keeps network rows when the page is scanned and replaces the page rows', () => {
    let tab = addNetwork(emptyTab(), row('a.mp4'), 1);
    tab = replacePage(
      tab,
      'https://example.test/b',
      [row('b.mp3', 'page')],
      { protectedMedia: false, blobOrMse: false },
      2,
    );
    tab = replacePage(
      tab,
      'https://example.test/b',
      [row('c.mp3', 'page')],
      { protectedMedia: false, blobOrMse: false },
      3,
    );
    expect(tab.items.map((item) => item.name)).toEqual(['a.mp4', 'c.mp3']);
  });

  it('remembers protected media once it was seen, even from an iframe', () => {
    const tab: TabMedia = { ...emptyTab(), protectedMedia: true };
    const next = replacePage(
      tab,
      'https://example.test/',
      [],
      { protectedMedia: false, blobOrMse: false },
      1,
    );
    expect(next.protectedMedia).toBe(true);
  });

  it('caps the rows of a tab and the number of tabs, dropping the one touched longest ago', () => {
    let tab = emptyTab();
    for (let i = 0; i < MAX_ITEMS + 10; i += 1) tab = addNetwork(tab, row(`f${i}.mp4`), i);
    expect(tab.items).toHaveLength(MAX_ITEMS);
    expect(tab.items[0]?.name).toBe('f10.mp4');
    const all: Record<string, TabMedia> = {};
    for (let id = 0; id < MAX_TABS + 5; id += 1) all[String(id)] = { ...emptyTab(), at: 1000 - id };
    all['1'] = { ...emptyTab(), at: 5000 }; // an old tab id that was touched just now
    const kept = limitTabs(all);
    expect(Object.keys(kept)).toHaveLength(MAX_TABS);
    expect(kept['1']).toBeDefined();
    expect(kept['0']).toBeDefined();
    expect(kept[String(MAX_TABS + 4)]).toBeUndefined();
  });

  it('reads an older stored shape and drops segment rows', () => {
    const tab = parseTab({
      pageUrl: 'https://p.test/',
      items: [
        { url: 'https://c.test/a.mp4', kind: 'video', name: 'a.mp4', source: 'network' },
        {
          url: 'https://c.test/s.ts',
          kind: 'video',
          name: 's.ts',
          source: 'network',
          manifestUrl: 'x',
        },
        { url: 5 },
      ],
    });
    expect(tab.items.map((item) => item.name)).toEqual(['a.mp4']);
    expect(tabCounts({ '3': tab, nope: tab }).get(3)).toBe(1);
  });
});

describe('MediaService', () => {
  const connection: ConnectionState = {
    kind: 'connected',
    targetId: 'local',
    baseUrl: 'http://127.0.0.1:9',
    version: '0.6.0',
  };

  function setup(over: { cookies?: boolean } = {}) {
    const captured: unknown[] = [];
    const imported: unknown[] = [];
    const painted: [number, number][] = [];
    const cookieCalls: CookieQuery[] = [];
    let clock = 1000;
    const area = memoryArea();
    const service = new MediaService({
      secrets: { get: () => Promise.resolve('token') },
      settings: { get: () => import('../settings/schema').then((m) => m.defaultSettings()) },
      connection: {
        get: () => Promise.resolve(connection),
        paintTab: (tabId, count) => {
          painted.push([tabId, count]);
          return Promise.resolve();
        },
      },
      session: area,
      log: silentLog,
      userAgent: 'TestAgent',
      now: () => (clock += 1),
      tasks: () => ({
        capture: (body) => {
          captured.push(body);
          return Promise.resolve({ task: { id: 't' } });
        },
        listQueues: () => Promise.resolve([{ id: 'main', name: 'Main' }]),
        importCookies: (cookies) => {
          imported.push(cookies);
          return Promise.resolve({ imported: cookies.length, skipped: 0, rejected: 0 });
        },
        resolve: () => Promise.resolve({ name: 'Clip', size: 10, duplicate: 'Old' }),
      }),
      ...(over.cookies
        ? {
            cookies: {
              getAll: (query: CookieQuery) => {
                cookieCalls.push(query);
                return Promise.resolve(
                  query.partitionKey
                    ? []
                    : [
                        { domain: 'cdn.example.test', name: 'sid', value: 's' },
                        { domain: 'other.test', name: 'no', value: 'x' },
                      ],
                );
              },
            },
          }
        : {}),
      fetchText: () =>
        Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\nmid.m3u8\n'),
    });
    return { service, captured, imported, painted, cookieCalls, area };
  }

  const snapshot = (over = {}) => ({
    pageUrl: 'https://example.test/watch',
    title: 'Watch',
    protectedMedia: false,
    blobOrMse: false,
    videos: [{ sources: ['https://cdn.example.test/master.m3u8'] }],
    audios: [],
    links: [],
    openGraph: [],
    jsonLd: [],
    ...over,
  });

  it('lists a tab, paints its badge, probes it, and offers qualities', async () => {
    const { service, painted } = setup();
    await service.scan(3, snapshot());
    expect((await service.forTab(3)).items.map((item) => item.kind)).toEqual(['hls']);
    expect(painted).toEqual([[3, 1]]);
    expect(await service.variants('https://cdn.example.test/master.m3u8')).toMatchObject([
      { quality: '720p', hint: '720p' },
    ]);
    expect(await service.probe(['https://cdn.example.test/master.m3u8'])).toEqual([
      { url: 'https://cdn.example.test/master.m3u8', name: 'Clip', size: 10, duplicate: 'Old' },
    ]);
  });

  it('keeps the manifest in the list however many segments follow', async () => {
    const { service } = setup();
    await service.observe({
      url: 'https://cdn.example.test/hls/master.m3u8',
      tabId: 3,
      mime: 'application/vnd.apple.mpegurl',
    });
    for (let i = 0; i < 300; i += 1) {
      await service.observe({ url: `https://cdn.example.test/hls/seg-${i}.ts`, tabId: 3 });
    }
    expect((await service.forTab(3)).items.map((item) => item.name)).toEqual(['master.m3u8']);
  });

  it('does not touch storage for a response that is not media', async () => {
    const { service, area } = setup();
    await service.observe({
      url: 'https://example.test/app.js',
      tabId: 3,
      mime: 'text/javascript',
    });
    await service.observe({ url: 'https://cdn.example.test/seg-1.ts', tabId: 3 });
    expect(await area.get('media.tabs')).toBeUndefined();
  });

  it('keeps every row when responses arrive at the same time', async () => {
    const { service } = setup();
    await Promise.all(
      Array.from({ length: 20 }, (_v, i) =>
        service.observe({
          url: `https://cdn.example.test/v${i}.mp4`,
          tabId: 3,
          sizeBytes: 5_000_000,
        }),
      ),
    );
    expect((await service.forTab(3)).items).toHaveLength(20);
  });

  it('starts the list again when the tab navigates, and forgets a closed tab', async () => {
    const { service, painted } = setup();
    await service.observe({
      url: 'https://cdn.example.test/a.mp4',
      tabId: 3,
      sizeBytes: 5_000_000,
    });
    await service.navigated(3, 'https://example.test/next');
    const after = await service.forTab(3);
    expect(after.items).toEqual([]);
    expect(after.pageUrl).toBe('https://example.test/next');
    expect(painted.at(-1)).toEqual([3, 0]);
    await service.observe({
      url: 'https://cdn.example.test/b.mp4',
      tabId: 3,
      sizeBytes: 5_000_000,
    });
    await service.closed(3);
    expect((await service.forTab(3)).items).toEqual([]);
  });

  it('counts one file once, whatever ranges were asked for', async () => {
    const { service } = setup();
    for (const range of ['0-99', '100-199', '200-299']) {
      await service.observe({
        url: `https://v.test/videoplayback.mp4?id=1&range=${range}`,
        tabId: 3,
        sizeBytes: 9_000_000,
      });
    }
    expect((await service.forTab(3)).items).toHaveLength(1);
  });

  it('marks protected media reported by an iframe', async () => {
    const { service } = setup();
    await service.markProtected(4);
    expect((await service.forTab(4)).protectedMedia).toBe(true);
  });

  it('sends a chosen quality as a capture with the page, the referrer, the stream kind and its own cookies', async () => {
    const { service, captured, cookieCalls } = setup({ cookies: true });
    const result = await service.download({
      url: 'https://cdn.example.test/stream',
      pageUrl: 'https://example.test/watch',
      quality: '720p',
      kind: 'hls',
      tabId: 3,
    });
    expect(result).toEqual({ ok: true });
    expect(captured[0]).toEqual({
      url: 'https://cdn.example.test/stream',
      cookieScope: 'task',
      userAgent: 'TestAgent',
      pageUrl: 'https://example.test/watch',
      referrer: 'https://example.test/watch',
      mediaCandidates: [{ url: 'https://cdn.example.test/stream', kind: 'hls', variant: '720p' }],
      cookies: [expect.objectContaining({ name: 'sid', value: 's' })],
    });
    expect(cookieCalls.length).toBeGreaterThan(0);
  });

  it('sends the page itself to yt-dlp, and reads no cookies for a private window', async () => {
    const { service, captured, cookieCalls } = setup({ cookies: true });
    await service.download({
      url: 'https://example.test/watch',
      resolverKind: 'ytdlp',
      incognito: true,
    });
    expect(captured[0]).toMatchObject({ resolverKind: 'ytdlp' });
    expect(captured[0]).not.toHaveProperty('mediaCandidates');
    expect(captured[0]).not.toHaveProperty('cookies');
    expect(cookieCalls).toEqual([]);
  });

  it('says so when DLM cannot be reached', async () => {
    const offline = new MediaService({
      secrets: { get: () => Promise.resolve(undefined) },
      settings: { get: () => import('../settings/schema').then((m) => m.defaultSettings()) },
      connection: { get: () => Promise.resolve({ kind: 'app-not-running' } as ConnectionState) },
      session: memoryArea(),
      log: silentLog,
      userAgent: 'x',
      tasks: () => ({
        capture: () => Promise.resolve(),
        listQueues: () => Promise.resolve([]),
        importCookies: () => Promise.reject(new Error('x')),
        resolve: () => Promise.reject(new Error('x')),
      }),
    });
    expect((await offline.download({ url: 'https://a.test/x.mp4' })).ok).toBe(false);
    expect(await offline.queues()).toEqual([]);
    expect(await offline.sendSiteCookies({ url: 'https://a.test/' })).toMatchObject({ ok: false });
  });

  it('sends a file as a capture with its chosen name, real address, size, queue and cookies of the real address', async () => {
    const { service, captured, cookieCalls } = setup({ cookies: true });
    await service.download({
      url: 'https://short.example.test/get?id=1',
      finalUrl: 'https://cdn.example.test/files/a.zip',
      name: 'My page.zip',
      sizeBytes: 5_000_000,
      mime: 'application/zip',
      queueId: 'night',
      paused: true,
      pageUrl: 'https://example.test/page',
      tabId: 3,
    });
    expect(captured[0]).toMatchObject({
      url: 'https://short.example.test/get?id=1',
      finalUrl: 'https://cdn.example.test/files/a.zip',
      name: 'My page.zip',
      size: 5_000_000,
      mime: 'application/zip',
      queueId: 'night',
      paused: true,
    });
    expect(cookieCalls[0]?.url).toBe('https://cdn.example.test/files/a.zip');
  });

  it('lists the queues, and sends the cookies of the site of a tab (its own domain only)', async () => {
    const { service, imported } = setup({ cookies: true });
    expect(await service.queues()).toEqual([{ id: 'main', name: 'Main' }]);
    const found = await service.siteCookies({ url: 'https://cdn.example.test/page' });
    expect(found.host).toBe('cdn.example.test');
    expect(found.cookies.map((c) => c.name)).toEqual(['sid']); // the other.test cookie is not this site's
    const sent = await service.sendSiteCookies({ url: 'https://cdn.example.test/page' });
    expect(sent).toEqual({
      ok: true,
      host: 'cdn.example.test',
      imported: 1,
      skipped: 0,
      rejected: 0,
    });
    expect(imported).toHaveLength(1);
  });

  it('sends no cookies from a private window unless allowed, and says when there are none', async () => {
    const { service, imported } = setup({ cookies: true });
    const result = await service.sendSiteCookies({
      url: 'https://cdn.example.test/',
      incognito: true,
    });
    expect(result).toMatchObject({ ok: false });
    expect(imported).toEqual([]);
  });
});
