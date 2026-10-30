import { describe, expect, it } from 'vitest';
import type { MediaView } from '../media/service';
import { memoryArea } from '../storage/area';
import { applyView, countKinds, entryFor, formatSize, needsCheck, nameFacts } from './entries';
import { nameFromDisposition } from './disposition';
import { fileKindOf, kindFromMime } from './kinds';
import { assignNames, extensionOf, nameFromLink, nameFromUrl, sanitizeFileName } from './naming';
import { ProbeCache, probeFile, runPool, type FetchFn } from './probe';

const response = (
  status: number,
  headers: Record<string, string> = {},
  url = 'https://cdn.test/a.zip',
) => {
  const res = new Response(null, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
};

describe('naming', () => {
  it.each([
    ['Big Buck Bunny: the movie? | Site', 'Big Buck Bunny the movie Site'],
    ['  ..hidden.. ', 'hidden'],
    ['a/b\\c*d', 'a b c d'],
    ['CON', '_CON'],
    ['', ''],
  ])('sanitises %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected.replace('the movie  Site', 'the movie Site'));
  });

  it('caps the length of a name', () => {
    expect(sanitizeFileName('x'.repeat(500))).toHaveLength(120);
  });

  it('finds an extension in names and addresses, and none where there is none', () => {
    expect(extensionOf('https://cdn.test/path/File.Name.ZIP?x=1')).toBe('zip');
    expect(extensionOf('report.final.pdf')).toBe('pdf');
    expect(extensionOf('https://cdn.test/download')).toBeUndefined();
    expect(extensionOf('.hidden')).toBeUndefined();
    expect(extensionOf('https://cdn.test/v%C3%ADdeo.mp4')).toBe('mp4');
  });

  it('names after a link: the server name, else the address, else a type-based name', () => {
    expect(nameFromLink({ url: 'https://cdn.test/a%20b.zip' })).toBe('a b.zip');
    expect(nameFromLink({ url: 'https://cdn.test/a.zip', serverName: 'Real Name.zip' })).toBe(
      'Real Name.zip',
    );
    expect(nameFromLink({ url: 'https://cdn.test/', mime: 'application/zip' })).toBe(
      'download.zip',
    );
    expect(nameFromLink({ url: 'https://cdn.test/live/master.m3u8', stream: true })).toBe(
      'master.mp4',
    );
    expect(nameFromUrl('not a url')).toBeUndefined();
  });

  it('names files after the page title with their own extension, and keeps same-extension files apart', () => {
    const files = [
      { id: '1', url: 'https://cdn.test/one.mp4', mime: 'video/mp4' },
      { id: '2', url: 'https://cdn.test/two.mp4', mime: 'video/mp4' },
      { id: '3', url: 'https://cdn.test/notes.pdf', mime: 'application/pdf' },
      { id: '4', url: 'https://cdn.test/get?id=9', mime: 'application/zip' },
    ];
    const names = assignNames(files, 'My Lecture: Part 1', 'title');
    expect([...names.values()]).toEqual([
      'My Lecture Part 1.mp4',
      'My Lecture Part 1 (two).mp4',
      'My Lecture Part 1.pdf',
      'My Lecture Part 1.zip',
    ]);
  });

  it('numbers a name that is still taken, and falls back to the link name for url naming or an empty title', () => {
    const same = [
      { id: '1', url: 'https://a.test/x/f.zip' },
      { id: '2', url: 'https://b.test/y/f.zip' },
      { id: '3', url: 'https://c.test/z/f.zip' },
    ];
    expect([...assignNames(same, 'T', 'title').values()]).toEqual([
      'T.zip',
      'T (f).zip',
      'T (f) (2).zip',
    ]);
    expect([...assignNames(same, 'Title', 'url').values()]).toEqual([
      'f.zip',
      'f (2).zip',
      'f (3).zip',
    ]);
    expect([...assignNames(same.slice(0, 1), '', 'title').values()]).toEqual(['f.zip']);
  });

  it('saves a stream as mp4', () => {
    const names = assignNames(
      [{ id: 's', url: 'https://cdn.test/m.m3u8', stream: true }],
      'Show',
      'title',
    );
    expect(names.get('s')).toBe('Show.mp4');
  });
});

describe('Content-Disposition', () => {
  it.each([
    ['attachment; filename="a b.zip"', 'a b.zip'],
    ["attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf", '€ rates.pdf'],
    ['attachment; filename=plain.bin', 'plain.bin'],
    ['attachment; filename="../../etc/passwd"', 'passwd'],
    ['inline', undefined],
  ])('%s', (value, expected) => {
    expect(nameFromDisposition(value)).toBe(expected);
  });
});

describe('kinds', () => {
  it('decides by extension, then by type', () => {
    expect(fileKindOf({ ext: 'iso' })).toBe('archive');
    expect(fileKindOf({ ext: 'bin', mime: 'video/mp4' })).toBe('video');
    expect(fileKindOf({ ext: 'bin', mime: 'application/octet-stream' })).toBe('other');
    expect(kindFromMime('application/vnd.apple.mpegurl')).toBe('stream');
  });
});

describe('probeFile', () => {
  const run = (fetch: FetchFn) => probeFile('https://short.test/get', { fetch, timeoutMs: 500 });

  it('follows redirects to the real file and reads its size, type and name', async () => {
    const result = await run(() =>
      Promise.resolve(
        response(
          200,
          {
            'content-length': '5000000',
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="r.zip"',
          },
          'https://cdn.test/real.zip',
        ),
      ),
    );
    expect(result).toEqual({
      ok: true,
      finalUrl: 'https://cdn.test/real.zip',
      sizeBytes: 5_000_000,
      mime: 'application/zip',
      serverName: 'r.zip',
    });
  });

  it('asks with HEAD, credentials and redirects followed', async () => {
    const seen: RequestInit[] = [];
    await run((_url, init) => {
      seen.push(init ?? {});
      return Promise.resolve(response(200, { 'content-length': '10' }));
    });
    expect(seen[0]).toMatchObject({ method: 'HEAD', credentials: 'include', redirect: 'follow' });
  });

  it('refuses a web page, an error, and a file with no size', async () => {
    expect(
      await run(() =>
        Promise.resolve(
          response(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '900' }),
        ),
      ),
    ).toEqual({ ok: false, reason: 'page' });
    expect(await run(() => Promise.resolve(response(404, { 'content-length': '10' })))).toEqual({
      ok: false,
      reason: 'status',
    });
    expect(
      await run(() => Promise.resolve(response(200, { 'content-type': 'application/zip' }))),
    ).toEqual({ ok: false, reason: 'size' });
    expect(await run(() => Promise.resolve(response(200, { 'content-length': '0' })))).toEqual({
      ok: false,
      reason: 'size',
    });
  });

  it('asks for one byte when HEAD is refused or has no size, and reads the whole size from Content-Range', async () => {
    const methods: string[] = [];
    const ranges: (string | null)[] = [];
    const result = await run((_url, init) => {
      methods.push(init?.method ?? '');
      ranges.push(new Headers(init?.headers).get('range'));
      return Promise.resolve(
        init?.method === 'HEAD'
          ? response(405)
          : response(206, {
              'content-range': 'bytes 0-0/7340032',
              'content-length': '1',
              'content-type': 'video/mp4',
            }),
      );
    });
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(ranges[1]).toBe('bytes=0-0');
    expect(result).toMatchObject({ ok: true, sizeBytes: 7_340_032 });
    const noSize = await run((_url, init) =>
      Promise.resolve(
        init?.method === 'HEAD'
          ? response(200, { 'content-type': 'video/mp4' })
          : response(206, { 'content-range': 'bytes 0-0/99' }),
      ),
    );
    expect(noSize).toMatchObject({ ok: true, sizeBytes: 99 });
  });

  it('does not use the one-byte size of a partial response as the file size', async () => {
    const result = await run((_url, init) =>
      Promise.resolve(
        init?.method === 'HEAD' ? response(405) : response(206, { 'content-length': '1' }),
      ),
    );
    expect(result).toEqual({ ok: false, reason: 'size' });
  });

  it('says network when nothing answers', async () => {
    expect(await run(() => Promise.reject(new TypeError('Failed to fetch')))).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('gives up on a server that never answers', async () => {
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(await probeFile('https://slow.test/a.zip', { fetch: hang, timeoutMs: 30 })).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('runPool', () => {
  it('runs at most `limit` at once, runs everything, and survives a failure', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (n === 4) throw new Error('boom');
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it('stops starting new work when aborted', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      1,
      (n) => {
        seen.push(n);
        if (n === 2) controller.abort();
        return Promise.resolve();
      },
      controller.signal,
    );
    expect(seen).toEqual([1, 2]);
  });
});

describe('ProbeCache', () => {
  it('remembers a result for ten minutes', async () => {
    let now = 1000;
    const cache = new ProbeCache(memoryArea(), () => now);
    await cache.put('https://a.test/x.zip', { ok: false, reason: 'page' });
    expect(await cache.get('https://a.test/x.zip')).toEqual({ ok: false, reason: 'page' });
    now += 11 * 60 * 1000;
    expect(await cache.get('https://a.test/x.zip')).toBeUndefined();
  });
});

describe('entries', () => {
  const row = (over: Partial<MediaView> = {}): MediaView => ({
    url: 'https://cdn.test/a.zip',
    kind: 'file',
    name: 'a.zip',
    ...over,
  });

  it('a network row with a size is valid without a check; a page row waits for its check', () => {
    expect(entryFor(row({ sizeBytes: 5000 }), undefined, true).state).toBe('valid');
    expect(entryFor(row(), undefined, true).state).toBe('pending');
    expect(needsCheck(row(), undefined)).toBe(true);
    expect(needsCheck(row({ sizeBytes: 5000 }), undefined)).toBe(false);
  });

  it('a checked row is valid with its size and real address, invalid when the check failed', () => {
    const ok = entryFor(
      row(),
      { ok: true, finalUrl: 'https://real.test/f.zip', sizeBytes: 9, mime: 'application/zip' },
      true,
    );
    expect(ok.state).toBe('valid');
    expect(ok.entry).toMatchObject({
      finalUrl: 'https://real.test/f.zip',
      sizeBytes: 9,
      kind: 'archive',
      host: 'real.test',
      ext: 'zip',
    });
    expect(entryFor(row(), { ok: false, reason: 'page' }, true).state).toBe('invalid');
    expect(needsCheck(row(), { ok: false, reason: 'page' })).toBe(false);
  });

  it('keeps the link as it is when redirects are not followed', () => {
    const { entry } = entryFor(
      row(),
      { ok: true, finalUrl: 'https://real.test/f.zip', sizeBytes: 9 },
      false,
    );
    expect(entry.finalUrl).toBe('https://cdn.test/a.zip');
  });

  it('a stream is valid without a size and is never checked', () => {
    const { entry, state } = entryFor(
      row({ url: 'https://cdn.test/m.m3u8', kind: 'hls' }),
      undefined,
      true,
    );
    expect(state).toBe('valid');
    expect(entry).toMatchObject({ kind: 'stream', stream: 'hls', sizeBytes: undefined });
    expect(needsCheck(row({ kind: 'hls' }), undefined)).toBe(false);
  });

  const entries = [
    ['https://a.test/small.zip', 1_000],
    ['https://a.test/big.mkv', 9_000_000_000],
    ['https://b.test/mid.pdf', 500_000],
  ].map(
    ([url, size]) =>
      entryFor(row({ url: String(url), sizeBytes: Number(size) }), undefined, true).entry,
  );
  const stream = entryFor(
    row({ url: 'https://c.test/live.m3u8', kind: 'hls' }),
    undefined,
    true,
  ).entry;
  const names = new Map<string, string>(
    entries.concat(stream).map((e) => [e.id, nameFromLink(nameFacts(e))]),
  );

  it('sorts by size either way, by name and by type, with streams last when sorting by size', () => {
    const all = [...entries, stream];
    const order = (sort: Parameters<typeof applyView>[2]['sort']) =>
      applyView(all, names, { query: '', kind: 'all', sort }).map((e) => names.get(e.id));
    expect(order('size-desc')).toEqual(['big.mkv', 'mid.pdf', 'small.zip', 'live.mp4']);
    expect(order('size-asc')).toEqual(['small.zip', 'mid.pdf', 'big.mkv', 'live.mp4']);
    expect(order('name')).toEqual(['big.mkv', 'live.mp4', 'mid.pdf', 'small.zip']);
    expect(order('type').at(0)).toBe('small.zip'); // archive, document, stream, video
  });

  it('filters by kind and by search over name, host and extension', () => {
    const all = [...entries, stream];
    expect(
      applyView(all, names, { query: '', kind: 'video', sort: 'name' }).map((e) => names.get(e.id)),
    ).toEqual(['big.mkv']);
    expect(
      applyView(all, names, { query: 'b.test', kind: 'all', sort: 'name' }).map((e) =>
        names.get(e.id),
      ),
    ).toEqual(['mid.pdf']);
    expect(applyView(all, names, { query: 'PDF', kind: 'all', sort: 'name' })).toHaveLength(1);
    expect([...countKinds(all)]).toContainEqual(['stream', 1]);
  });

  it('formats sizes the way the app does', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1500)).toBe('1.5 KB');
    expect(formatSize(820_000)).toBe('820 KB');
    expect(formatSize(1_400_000_000)).toBe('1.4 GB');
    expect(formatSize(undefined)).toBe('');
  });
});
