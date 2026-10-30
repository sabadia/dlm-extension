import { describe, expect, it } from 'vitest';
import { defaultSettings, type Rules } from '../settings/schema';
import { decide, fileExtension, type DownloadFacts, type Decision } from './rules';

function facts(over: Partial<DownloadFacts> = {}): DownloadFacts {
  return {
    url: 'https://files.example.test/archive.zip',
    sizeBytes: 5_000_000,
    filename: 'archive.zip',
    mime: 'application/zip',
    incognito: false,
    altKey: false,
    shiftKey: false,
    own: false,
    ...over,
  };
}

function rules(over: Partial<Rules> = {}): Rules {
  return { ...defaultSettings().rules, ...over };
}

describe('decide', () => {
  it.each<[string, Partial<Rules>, Partial<DownloadFacts>, Decision]>([
    ['takes a normal download', {}, {}, { action: 'take' }],
    ['leaves our own fallback', {}, { own: true }, { action: 'leave', reason: 'own' }],
    [
      'leaves a blob address',
      {},
      { url: 'blob:https://example.test/id' },
      { action: 'leave', reason: 'scheme' },
    ],
    [
      'leaves a data address',
      {},
      { url: 'data:text/plain,hi' },
      { action: 'leave', reason: 'scheme' },
    ],
    ['takes ftp', {}, { url: 'ftp://files.example.test/a.zip' }, { action: 'take' }],
    ['leaves a POST', {}, { method: 'POST' }, { action: 'leave', reason: 'method' }],
    ['takes a small POST', {}, { method: 'POST', postBody: 'aGk=' }, { action: 'take' }],
    [
      'leaves everything when interception is off',
      { intercept: false },
      {},
      { action: 'leave', reason: 'off' },
    ],
    [
      'leaves a private window unless it is allowed',
      {},
      { incognito: true },
      { action: 'leave', reason: 'private' },
    ],
    [
      'takes a private window when it is allowed',
      { privateWindows: true },
      { incognito: true },
      { action: 'take' },
    ],
    [
      'leaves a download started with Alt held',
      {},
      { altKey: true },
      { action: 'leave', reason: 'bypass' },
    ],
    [
      'uses Shift when that is the bypass key',
      { bypassKey: 'shift' },
      { altKey: true, shiftKey: true },
      { action: 'leave', reason: 'bypass' },
    ],
    [
      'ignores Alt when the bypass key is none',
      { bypassKey: 'none' },
      { altKey: true },
      { action: 'take' },
    ],
    [
      'leaves an excluded site and its subdomains',
      { excludedSites: ['example.test'] },
      { url: 'https://cdn.example.test/a.zip' },
      { action: 'leave', reason: 'site' },
    ],
    [
      'does not let a suffix of the host pretend to be a subdomain',
      { excludedSites: ['example.test'] },
      { url: 'https://notexample.test/a.zip' },
      { action: 'take' },
    ],
    [
      'exclusion wins over always',
      { excludedSites: ['example.test'], alwaysSites: ['example.test'] },
      {},
      { action: 'leave', reason: 'site' },
    ],
    [
      'always takes a small file of an unlisted type',
      { alwaysSites: ['example.test'], minSizeBytes: 9_000_000, fileTypes: ['pdf'] },
      { filename: 'note.txt', mime: 'text/plain', sizeBytes: 10 },
      { action: 'take' },
    ],
    [
      'leaves a file smaller than the minimum',
      { minSizeBytes: 1_000_000 },
      { sizeBytes: 999_999 },
      { action: 'leave', reason: 'size' },
    ],
    [
      'takes a file of exactly the minimum',
      { minSizeBytes: 1_000_000 },
      { sizeBytes: 1_000_000 },
      { action: 'take' },
    ],
    [
      'leaves a type outside the file list',
      { fileTypes: ['zip', 'pdf'] },
      { filename: 'song.mp3', url: 'https://files.example.test/song.mp3' },
      { action: 'leave', reason: 'type' },
    ],

    [
      'matches a MIME group',
      { mimeTypes: ['video/'] },
      { filename: 'clip', mime: 'video/mp4; codecs=avc1' },
      { action: 'take' },
    ],
    [
      'accepts either list when both are set',
      { fileTypes: ['zip'], mimeTypes: ['application/pdf'] },
      { filename: 'doc.pdf', mime: 'application/pdf' },
      { action: 'take' },
    ],
    [
      'leaves a download that matches neither list',
      { fileTypes: ['zip'], mimeTypes: ['application/pdf'] },
      { filename: 'song.mp3', mime: 'audio/mpeg' },
      { action: 'leave', reason: 'type' },
    ],

    ['asks when ask-first is on', { askFirst: true }, {}, { action: 'ask' }],
    [
      'does not ask about a file that would stay in the browser',
      { askFirst: true, minSizeBytes: 9_000_000 },
      { sizeBytes: 10 },
      { action: 'leave', reason: 'size' },
    ],
    [
      'does not ask for a site set to always',
      { askFirst: true, alwaysSites: ['example.test'] },
      {},
      { action: 'take' },
    ],
    [
      'the bypass key still wins on a site set to always',
      { alwaysSites: ['example.test'] },
      { altKey: true },
      { action: 'leave', reason: 'bypass' },
    ],
    [
      'a private window stays private even on a site set to always',
      { alwaysSites: ['example.test'] },
      { incognito: true },
      { action: 'leave', reason: 'private' },
    ],
  ])('%s', (_name, ruleOver, factOver, expected) => {
    expect(decide(rules(ruleOver), facts(factOver))).toEqual(expected);
  });
});

describe('missing facts', () => {
  function bare(url: string): DownloadFacts {
    return { url, incognito: false, altKey: false, shiftKey: false, own: false };
  }

  it('counts a missing method and an unknown size as a download to take', () => {
    expect(decide(rules(), bare('https://files.example.test/download'))).toEqual({
      action: 'take',
    });
  });

  it('reads the extension from the address when the name has none', () => {
    expect(
      decide(rules({ fileTypes: ['zip'] }), bare('https://files.example.test/dir/Archive.ZIP?x=1')),
    ).toEqual({
      action: 'take',
    });
  });

  it('leaves a filtered download that says neither its name nor its type', () => {
    expect(
      decide(rules({ fileTypes: ['zip'] }), bare('https://files.example.test/download')),
    ).toEqual({
      action: 'leave',
      reason: 'type',
    });
  });
});

describe('fileExtension', () => {
  it('prefers the file name and ignores a trailing dot', () => {
    expect(fileExtension('C:\\Users\\a\\Report.PDF', 'https://x.test/a')).toBe('pdf');
    expect(fileExtension('readme', 'https://x.test/a.tar.gz')).toBe('gz');
    expect(fileExtension('.', 'https://x.test/download')).toBeUndefined();
  });
});
