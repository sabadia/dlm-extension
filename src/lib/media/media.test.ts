import { describe, expect, it } from 'vitest';
import { classifyNetwork, isTracker } from './classify';
import { mediaFromPage, jsonLdContentUrls } from './page';
import { parseDash, parseHls } from './playlist';
import { MediaService } from './service';
import { addNetwork, replacePage, visibleItems, type TabMedia } from './store';
import type { ConnectionState } from '../connection/state';
import { silentLog } from '../log/log';
import { memoryArea } from '../storage/area';

const empty = (): TabMedia => ({ pageUrl: '', protectedMedia: false, blobOrMse: false, items: [] });

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
});

describe('playlists', () => {
  it('reads HLS qualities and DASH representations', () => {
    const hls = parseHls(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1920x1080\nhigh.m3u8\n',
      'https://cdn.example.test/master.m3u8',
    );
    expect(hls.map((item) => item.quality)).toEqual(['1080p', '360p']);
    expect(hls[0]?.url).toBe('https://cdn.example.test/high.m3u8');
    const dash = parseDash(
      '<MPD><Representation bandwidth="800" mimeType="audio/mp4"><BaseURL>a.m4s</BaseURL></Representation><Representation bandwidth="4000" height="720"><BaseURL>v.mp4</BaseURL></Representation></MPD>',
      'https://cdn.example.test/manifest.mpd',
    );
    expect(dash.map((item) => item.quality)).toEqual(['720p', 'audio']);
  });
});

describe('page scan', () => {
  it('collects video, file links, open graph and JSON-LD, and skips blob addresses', () => {
    const items = mediaFromPage({
      pageUrl: 'https://example.test/watch',
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
});

describe('tab store', () => {
  it('hides segments and replaces page rows when the document changes', () => {
    let tab = addNetwork(
      empty(),
      { url: 'https://cdn.example.test/a.mp4', kind: 'video', name: 'a.mp4', source: 'network' },
      'https://example.test/a',
    );
    tab = addNetwork(
      tab,
      {
        url: 'https://cdn.example.test/seg.ts',
        kind: 'video',
        name: 'seg.ts',
        source: 'network',
        manifestUrl: 'https://cdn.example.test/a.m3u8',
      },
      'https://example.test/a',
    );
    expect(visibleItems(tab).map((item) => item.name)).toEqual(['a.mp4']);
    tab = replacePage(
      tab,
      'https://example.test/b',
      [{ url: 'https://cdn.example.test/b.mp3', kind: 'audio', name: 'b.mp3', source: 'page' }],
      { protectedMedia: true, blobOrMse: false },
    );
    expect(tab.items.map((item) => item.name)).toEqual(['b.mp3']);
    expect(tab.protectedMedia).toBe(true);
  });
});

describe('MediaService', () => {
  it('lists a tab, probes it, and sends a chosen quality', async () => {
    const created: unknown[] = [];
    const area = memoryArea();
    let painted = 0;
    const connection: ConnectionState = {
      kind: 'connected',
      targetId: 'local',
      baseUrl: 'http://127.0.0.1:9',
      version: '0.6.0',
    };
    const service = new MediaService({
      secrets: { get: () => Promise.resolve('token') },
      connection: {
        get: () => Promise.resolve(connection),
        repaint: () => {
          painted += 1;
          return Promise.resolve();
        },
      },
      session: area,
      log: silentLog,
      tasks: () => ({
        create: (body) => {
          created.push(body);
          return Promise.resolve({ id: 't' });
        },
        resolve: () => Promise.resolve({ name: 'Clip', size: 10, duplicate: 'Old' }),
      }),
      fetchText: () =>
        Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\nmid.m3u8\n'),
    });
    await service.scan(
      3,
      {
        pageUrl: 'https://example.test/watch',
        protectedMedia: false,
        blobOrMse: false,
        videos: [{ sources: ['https://cdn.example.test/master.m3u8'] }],
        audios: [],
        links: [],
        openGraph: [],
        jsonLd: [],
      },
      true,
    );
    const listed = await service.forTab(3);
    expect(listed.items.map((item) => item.kind)).toEqual(['hls']);
    expect(painted).toBe(1);
    expect(await service.variants('https://cdn.example.test/master.m3u8')).toMatchObject([
      { quality: '720p', url: 'https://cdn.example.test/mid.m3u8' },
    ]);
    expect(await service.probe(['https://cdn.example.test/master.m3u8'])).toEqual([
      { url: 'https://cdn.example.test/master.m3u8', name: 'Clip', size: 10, duplicate: 'Old' },
    ]);
    expect(
      await service.download({
        url: 'https://cdn.example.test/mid.m3u8',
        quality: '720p',
        kind: 'hls',
      }),
    ).toEqual({
      ok: true,
    });
    expect(created[0]).toMatchObject({
      source: {
        currentUrl: 'https://cdn.example.test/mid.m3u8',
        mediaHint: '720p',
        streamKind: 'hls',
      },
    });
  });
});
