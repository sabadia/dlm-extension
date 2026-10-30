import { describe, expect, it } from 'vitest';
import {
  acceptedHints,
  checksumIn,
  hintFor,
  mirrorsFor,
  pageHints,
  rememberPageHints,
  type HintLink,
} from './hints';
import { HintStore } from './store';
import { memoryArea } from '../storage/area';

const sha = 'a'.repeat(64);
const sha1 = 'c'.repeat(40);
const md5 = 'b'.repeat(32);

describe('checksumIn', () => {
  it('prefers a labelled hash and the longer of two bare hashes', () => {
    expect(checksumIn(`SHA-256: ${sha}`)).toEqual({ algorithm: 'sha256', expected: sha });
    expect(checksumIn(`md5 ${md5}`)).toEqual({ algorithm: 'md5', expected: md5 });
    expect(checksumIn(`file ${sha}`)).toEqual({ algorithm: 'sha256', expected: sha });
    expect(checksumIn(`file ${sha1}`)).toEqual({ algorithm: 'sha1', expected: sha1 });
    expect(checksumIn('no hash here')).toBeUndefined();
  });

  it('takes a whole run of hex digits, never the first part of a longer one', () => {
    // 64 digits labelled SHA1 are not a SHA-1 hash of their first 40: they are a (bare) SHA-256.
    expect(checksumIn(`SHA1: ${sha}`)).toEqual({ algorithm: 'sha256', expected: sha });
    expect(checksumIn(`id ${'d'.repeat(70)}`)).toBeUndefined();
    expect(checksumIn(`SHA256 ${sha}f`)).toBeUndefined();
  });

  it('does not take 32 hex digits for an MD5 hash unless the text says MD5', () => {
    expect(checksumIn(`cache key ${md5}`)).toBeUndefined();
    expect(checksumIn(`MD5 checksum: ${md5}`)).toEqual({ algorithm: 'md5', expected: md5 });
  });
});

describe('mirrors', () => {
  const file = (url: string, text = ''): HintLink => ({ url, text, nearby: text });

  it('sends other links to the same file on a mirror page, and nothing on an ordinary page', () => {
    const links = [
      file('https://a.example.test/app.zip', 'Download'),
      file('https://b.example.test/app.zip', 'Mirror 2'),
      file('https://c.example.test/readme', 'Read me'),
    ];
    expect(mirrorsFor('https://a.example.test/app.zip', links)).toEqual([
      'https://b.example.test/app.zip',
    ]);
    expect(
      mirrorsFor('https://a.example.test/app.zip', [
        file('https://a.example.test/app.zip'),
        file('https://news.example.test/story'),
      ]),
    ).toEqual([]);
  });

  it('does not count translated copies of one document on the same site as mirrors', () => {
    const links = [
      file('https://docs.example.test/en/guide.pdf', 'English'),
      file('https://docs.example.test/fr/guide.pdf', 'Français'),
    ];
    expect(mirrorsFor('https://docs.example.test/en/guide.pdf', links)).toEqual([]);
  });

  it('does not take the word mirror in the text around a link for a mirror page', () => {
    const links: HintLink[] = [
      {
        url: 'https://a.example.test/app.zip',
        text: 'Download',
        nearby: 'Download (mirrors below)',
      },
      { url: 'https://b.example.test/other.zip', text: 'Other', nearby: 'Other' },
    ];
    expect(mirrorsFor('https://a.example.test/app.zip', links)).toEqual([]);
  });

  it('keeps a checksum and the mirrors with the link', () => {
    const links = [
      file('https://a.example.test/app.zip', `Download SHA256 ${sha}`),
      file('https://b.example.test/app.zip', 'mirror'),
    ];
    expect(pageHints(links)[0]).toEqual({
      url: 'https://a.example.test/app.zip',
      checksum: { algorithm: 'sha256', expected: sha },
      mirrors: ['https://b.example.test/app.zip'],
    });
  });

  it('handles a page with thousands of links without scanning every link for every link', () => {
    const links: HintLink[] = Array.from({ length: 4000 }, (_v, i) => ({
      url: `https://host${i % 50}.example.test/file${i}.zip`,
      text: `file ${i}`,
      nearby: '',
    }));
    const started = Date.now();
    pageHints(links);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('hints belong to the page that reported them', () => {
  const url = 'https://vendor.example/app.zip';
  const hint = { url, checksum: { algorithm: 'md5' as const, expected: md5 } };

  it('replaces the hint of the same page and address, and forgets an old one', () => {
    const first = rememberPageHints([], [hint], 'https://a.test', 0);
    const next = rememberPageHints(
      first,
      [{ url, mirrors: ['https://b.example.test/app.zip'] }],
      'https://a.test',
      1,
    );
    expect(hintFor(next, [url], 'https://a.test', 1)?.mirrors).toEqual([
      'https://b.example.test/app.zip',
    ]);
    expect(hintFor(next, [url], 'https://a.test', 1 + 11 * 60 * 1000)).toBeUndefined();
  });

  it('is not used for a download that started on another page', () => {
    const list = rememberPageHints([], [hint], 'https://evil.test', 0);
    expect(hintFor(list, [url], 'https://vendor.example', 1)).toBeUndefined();
    expect(hintFor(list, [url], undefined, 1)).toBeUndefined();
    expect(hintFor(list, [url], 'https://evil.test', 1)).toBeDefined();
  });

  it('does not let one page replace what another page said', () => {
    let list = rememberPageHints([], [hint], 'https://vendor.example', 0);
    list = rememberPageHints(
      list,
      [{ url, checksum: { algorithm: 'md5', expected: 'e'.repeat(32) } }],
      'https://evil.test',
      1,
    );
    expect(hintFor(list, [url], 'https://vendor.example', 2)?.checksum?.expected).toBe(md5);
  });

  it('survives a restart of the worker through the store', async () => {
    const area = memoryArea();
    await new HintStore(area).note([hint], 'https://vendor.example', 5);
    const again = new HintStore(area);
    expect((await again.find([url], 'https://vendor.example', 6))?.checksum?.expected).toBe(md5);
    expect(await again.find([url], 'https://other.test', 6)).toBeUndefined();
  });
});

describe('acceptedHints', () => {
  it('drops everything that is not a well-formed hint', () => {
    const accepted = acceptedHints([
      { url: 'javascript:alert(1)', checksum: { algorithm: 'md5', expected: md5 } },
      { url: 'https://a.test/x', checksum: { algorithm: 'md5', expected: 'short' } },
      { url: 'https://a.test/y', mirrors: ['https://b.test/y', 'ftp://c.test/y', 5] },
      'nonsense',
    ]);
    expect(accepted).toEqual([{ url: 'https://a.test/y', mirrors: ['https://b.test/y'] }]);
  });
});
