import { describe, expect, it } from 'vitest';
import { isDirectScheme, isEd2k, isMagnet, isTorrent } from './classify';
import { chunk, filterLinks, patternRejected, type PageLink } from './filter';
import { menuAction, menuTree, targetUrl } from './menus';
import { LinksService, type MenuClick, type TaskPort } from './service';
import type { ConnectionState } from '../connection/state';
import { silentLog } from '../log/log';
import { memoryArea } from '../storage/area';

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
      settings: { get: () => Promise.reject(new Error('unused')) },
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
