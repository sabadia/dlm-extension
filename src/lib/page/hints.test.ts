import { describe, expect, it } from 'vitest';
import {
  checksumIn,
  hintFor,
  mirrorsFor,
  pageHints,
  rememberPageHints,
  type HintLink,
} from './hints';

const sha = 'a'.repeat(64);
const md5 = 'b'.repeat(32);

describe('checksumIn', () => {
  it('prefers a labelled hash and the longer of two bare hashes', () => {
    expect(checksumIn(`SHA-256: ${sha}`)).toEqual({ algorithm: 'sha256', expected: sha });
    expect(checksumIn(`md5 ${md5}`)).toEqual({ algorithm: 'md5', expected: md5 });
    expect(checksumIn(`file ${sha}`)).toEqual({ algorithm: 'sha256', expected: sha });
    expect(checksumIn('no hash here')).toBeUndefined();
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
});

describe('rememberPageHints', () => {
  it('replaces a hint for the same address and forgets an old one', () => {
    const first = rememberPageHints(
      [],
      [{ url: 'https://a.example.test/app.zip', checksum: { algorithm: 'md5', expected: md5 } }],
      0,
    );
    const next = rememberPageHints(
      first,
      [{ url: 'https://a.example.test/app.zip', mirrors: ['https://b.example.test/app.zip'] }],
      1,
    );
    expect(hintFor(next, ['https://a.example.test/app.zip'], 1)?.mirrors).toEqual([
      'https://b.example.test/app.zip',
    ]);
    expect(hintFor(next, ['https://a.example.test/app.zip'], 1 + 11 * 60 * 1000)).toBeUndefined();
  });
});
