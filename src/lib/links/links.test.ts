import { describe, expect, it } from 'vitest';
import { isDirectScheme, isEd2k, isMagnet, isTorrent } from './classify';
import { chunk, filterLinks, patternRejected, type PageLink } from './filter';
import { menuAction, menuTree, targetUrl } from './menus';
import { LinksService, type MenuClick, type TaskPort } from './service';
import type { ConnectionState } from '../connection/state';
import { silentLog } from '../log/log';
import { memoryArea } from '../storage/area';
import { defaultSettings } from '../settings/schema';

const link = (url: string, over: Partial<PageLink> = {}): PageLink => ({
  url,
  text: url,
  kind: 'link',
  ...over,
});

describe('direct schemes and torrents', () => {
  it('recognises magnet and ed2k links and torrent files', () => {
    expect(isMagnet('magnet:?xt=urn:btih:abc')).toBe(true);
    expect(isEd2k('ed2k://|file|a|1|h|/')).toBe(true);
    expect(isDirectScheme('https://example.test/a')).toBe(false);
    expect(isTorrent({ filename: '/tmp/a.torrent' })).toBe(true);
    expect(isTorrent({ url: 'https://x.test/a', mime: 'application/x-bittorrent' })).toBe(true);
    expect(isTorrent({ url: 'https://x.test/a.zip', mime: 'application/zip' })).toBe(false);
  });
});

describe('filterLinks', () => {
  const links = [
    link('https://files.example.test/a.zip', { text: 'archive', sizeBytes: 5_000_000 }),
    link('https://files.example.test/note.txt', { sizeBytes: 20 }),
    link('https://cdn.example.test/clip.mp4', { kind: 'video' }),
    link('https://files.example.test/a.zip', { text: 'again' }),
  ];

  it('filters by extension, pattern and known size, and keeps one of each address', () => {
    expect(
      filterLinks(links, { extensions: ['zip'], pattern: 'archive', minSizeBytes: 1000 }).map(
        (item) => item.url,
      ),
    ).toEqual(['https://files.example.test/a.zip']);
    expect(
      filterLinks(links, { extensions: [], pattern: '', minSizeBytes: 1000 }).map(
        (item) => item.text,
      ),
    ).toEqual(['archive', 'https://cdn.example.test/clip.mp4']);
    expect(patternRejected('[')).toBe(true);
    expect(filterLinks(links, { extensions: [], pattern: '[', minSizeBytes: 0 })).toEqual([]);
  });

  it('splits a long list into batches of 100', () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i)).map((group) => group.length)).toEqual([
      100, 100, 50,
    ]);
  });
});

describe('menus', () => {
  it('builds a queue submenu and reads the click back', () => {
    const tree = menuTree([{ id: 'movies', name: 'Movies' }], true);
    const ids = tree.map((item) => item.id);
    expect(ids).toContain('dlm:link:queue:movies');
    expect(ids).toContain('dlm:page:paused');
    expect(ids).toContain('dlm:all');
    expect(menuAction('dlm:link:queue:movies')).toEqual({
      kind: 'add',
      context: 'link',
      queueId: 'movies',
    });
    expect(menuAction('dlm:image:paused')).toEqual({ kind: 'paused' });
    expect(menuAction('dlm:all')).toEqual({ kind: 'all' });
    expect(menuAction('other')).toBeUndefined();
    expect(targetUrl('link', { linkUrl: 'https://files.example.test/a.zip' })).toBe(
      'https://files.example.test/a.zip',
    );
    expect(targetUrl('selection', { selectionText: 'not a url' })).toBeUndefined();
    expect(targetUrl('page', { pageUrl: 'https://example.test/watch' })).toBe(
      'https://example.test/watch',
    );
  });
});

describe('LinksService', () => {
  function harness() {
    const created: { url: string; queueId?: string; paused?: boolean }[] = [];
    const torrents: { bytes: number; name?: string }[] = [];
    const opened: string[] = [];
    const menus: { id: string }[] = [];
    const connection: ConnectionState = {
      kind: 'connected',
      targetId: 'local',
      baseUrl: 'http://127.0.0.1:9',
      version: '0.6.0',
    };
    const tasks: TaskPort = {
      listQueues: () => Promise.resolve({ queues: [{ id: 'main', name: 'Main' }] }),
      create: (body) => {
        created.push(body);
        return Promise.resolve({ id: 't' });
      },
      createMany: (items) => {
        created.push(...items);
        return Promise.resolve(items.map(() => ({ ok: true })));
      },
      addTorrent: (bytes, query) => {
        torrents.push({ bytes: bytes.byteLength, ...(query.name ? { name: query.name } : {}) });
        return Promise.resolve({ id: 'tor' });
      },
    };
    const service = new LinksService({
      settings: { get: () => Promise.resolve(defaultSettings()) },
      secrets: { get: () => Promise.resolve('token') },
      connection: { get: () => Promise.resolve(connection) },
      session: memoryArea(),
      log: silentLog,
      menus: {
        removeAll: () => Promise.resolve(),
        create: (spec) => {
          menus.push({ id: spec.id });
        },
        open: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      tasks: () => tasks,
      linksUrl: (tabId) => `links.html?tab=${tabId}`,
      fetchFile: () => Promise.resolve(new Uint8Array([100, 101])),
    });
    return { service, created, torrents, opened, menus };
  }

  it('sends a menu click to the chosen queue and opens the all-links page', async () => {
    const { service, created, opened, menus } = harness();
    await service.install();
    expect(menus.some((item) => item.id === 'dlm:link:queue:main')).toBe(true);
    const click: MenuClick = {
      menuItemId: 'dlm:link:queue:main',
      linkUrl: 'https://files.example.test/a.zip',
    };
    await service.onClick(click);
    expect(created).toEqual([
      { url: 'https://files.example.test/a.zip', queueId: 'main', paused: false },
    ]);
    await service.onClick({ menuItemId: 'dlm:all', tabId: 4 });
    expect(opened).toEqual(['links.html?tab=4']);
  });

  it('names a menu download after the page title and the extension of the link', async () => {
    const { service, created } = harness();
    await service.install();
    await service.onClick({
      menuItemId: 'dlm:link:queue:main',
      linkUrl: 'https://files.example.test/a.zip',
      tabTitle: 'Annual Report | Example',
    });
    expect(created.at(-1)).toMatchObject({ name: 'Annual Report - Example.zip' });
    await service.onClick({
      menuItemId: 'dlm:link:queue:main',
      linkUrl: 'https://files.example.test/download',
      tabTitle: 'Annual Report',
    });
    expect(created.at(-1)).not.toHaveProperty('name');
  });

  it('uploads torrent bytes when the download had cookies, and the URL otherwise', async () => {
    const { service, created, torrents } = harness();
    expect(
      await service.addTorrent({
        url: 'https://files.example.test/a.torrent',
        filename: 'a.torrent',
        cookies: [{ domain: 'files.example.test', name: 's', value: 'v' }],
      }),
    ).toBe('taken');
    expect(torrents).toEqual([{ bytes: 2, name: 'a.torrent' }]);
    expect(await service.addTorrent({ url: 'https://files.example.test/b.torrent' })).toBe('taken');
    expect(created.at(-1)).toMatchObject({ url: 'https://files.example.test/b.torrent' });
  });

  it('sends a magnet link and a batch', async () => {
    const { service, created } = harness();
    expect(await service.addDirect('magnet:?xt=urn:btih:abc')).toBe(true);
    const sent = await service.sendMany(['https://a.test/1', 'https://a.test/2']);
    expect(sent).toEqual({ ok: 2, failed: 0 });
    expect(created.map((item) => item.url)).toEqual([
      'magnet:?xt=urn:btih:abc',
      'https://a.test/1',
      'https://a.test/2',
    ]);
  });
});

describe('LinksService review fixes', () => {
  function build(options: { fail?: boolean } = {}) {
    const events: string[] = [];
    const notes: string[] = [];
    const updates: { id: string; checked: boolean }[] = [];
    const connection: ConnectionState = {
      kind: 'connected',
      targetId: 'local',
      baseUrl: 'http://127.0.0.1:9',
      version: '0.6.0',
    };
    const tasks: TaskPort = {
      listQueues: () => {
        events.push('queues');
        return Promise.resolve({ queues: [{ id: 'main', name: 'Main' }] });
      },
      create: (body) =>
        options.fail ? Promise.reject(new Error('down')) : Promise.resolve({ url: body.url }),
      createMany: () => Promise.resolve([]),
      addTorrent: () => Promise.resolve({}),
    };
    const service = new LinksService({
      settings: { get: () => Promise.resolve(defaultSettings()) },
      secrets: { get: () => Promise.resolve('token') },
      connection: { get: () => Promise.resolve(connection) },
      session: memoryArea(),
      log: silentLog,
      menus: {
        removeAll: async () => {
          events.push('removeAll');
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        create: (spec) => {
          events.push(`create ${spec.id}`);
        },
        update: (id, change) => {
          updates.push({ id, checked: change.checked });
        },
        open: () => Promise.resolve(),
      },
      tasks: () => tasks,
      notify: (message) => notes.push(message),
      linksUrl: () => 'links.html',
    });
    return { service, events, notes, updates };
  }

  it('builds the menus one build after another, never in each other', async () => {
    const { service, events } = build();
    await Promise.all([service.install(), service.install()]);
    const marks = events.filter((entry) => entry === 'removeAll' || entry.startsWith('queues'));
    // queues, removeAll, ...creates, queues, removeAll, ...creates (no second removeAll before the first creates).
    const firstRemove = events.indexOf('removeAll');
    const secondRemove = events.indexOf('removeAll', firstRemove + 1);
    const between = events.slice(firstRemove, secondRemove);
    expect(between.filter((entry) => entry.startsWith('create '))).not.toHaveLength(0);
    expect(marks.filter((entry) => entry === 'removeAll')).toHaveLength(2);
  });

  it('tells the person when a menu click could not be sent, and when it was', async () => {
    const failing = build({ fail: true });
    await failing.service.onClick({
      menuItemId: 'dlm:link:queue:main',
      linkUrl: 'https://files.example.test/a.zip',
    });
    expect(failing.notes).toHaveLength(1);
    const working = build();
    await working.service.onClick({
      menuItemId: 'dlm:link:queue:main',
      linkUrl: 'https://files.example.test/a.zip',
    });
    expect(working.notes).toEqual(['Sent 1 to DLM.']);
  });

  it('keeps the add-paused checkboxes of every place in step', async () => {
    const { service, updates } = build();
    await service.onClick({ menuItemId: 'dlm:image:paused', checked: true });
    expect(updates).toHaveLength(6);
    expect(updates.every((update) => update.checked)).toBe(true);
    expect(updates.map((update) => update.id)).toContain('dlm:page:paused');
  });

  it('refuses a pattern that is too long to test against every link', () => {
    expect(patternRejected('a'.repeat(201))).toBe(true);
    expect(
      filterLinks([link('https://a.test/a')], {
        extensions: [],
        pattern: 'a'.repeat(201),
        minSizeBytes: 0,
      }),
    ).toEqual([]);
  });
});
