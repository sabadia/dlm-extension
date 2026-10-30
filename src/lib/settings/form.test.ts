import { describe, expect, it } from 'vitest';
import { draftFrom, entries, settingsFrom } from './form';
import { defaultSettings } from './schema';

const current = defaultSettings();
const draft = () => draftFrom(current);

describe('entries', () => {
  it('splits on line breaks and commas, and skips empty ones', () => {
    expect(entries('a.test\n\n b.test, c.test ,\n')).toEqual(['a.test', 'b.test', 'c.test']);
    expect(entries('')).toEqual([]);
  });
});

describe('draftFrom and settingsFrom', () => {
  it('turns the settings into text and back into the same settings', () => {
    const settings = {
      ...current,
      rules: {
        ...current.rules,
        excludedSites: ['a.test', 'b.test'],
        fileTypes: ['zip', 'iso'],
        mimeTypes: ['video/'],
        minSizeBytes: 2048,
      },
    };
    const result = settingsFrom(draftFrom(settings), settings, ['local']);
    expect(result).toEqual({
      ok: true,
      patch: {
        rules: settings.rules,
        preferences: settings.preferences,
        routes: [],
        files: settings.files,
      },
    });
  });

  it('parses what was typed: several lines, commas, case, a scheme and a dot', () => {
    const result = settingsFrom(
      {
        ...draft(),
        minSize: ' 4096 ',
        excludedSites: 'Example.COM\nhttps://www.other.test/page,.third.test',
        alwaysSites: '*.cdn.test',
        fileTypes: '.ZIP, iso\n7z',
        mimeTypes: 'Video/, application/zip; charset=x',
      },
      current,
      ['local'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.rules).toMatchObject({
      minSizeBytes: 4096,
      excludedSites: ['example.com', 'www.other.test', 'third.test'],
      alwaysSites: ['cdn.test'],
      fileTypes: ['zip', 'iso', '7z'],
      mimeTypes: ['video/', 'application/zip'],
    });
  });

  it('refuses a size that is not a number, including an empty one, instead of turning it into 0 or 1 MB', () => {
    for (const bad of ['', '  ', '12x', '1e3', '-5', '1.5']) {
      const result = settingsFrom({ ...draft(), minSize: bad }, current, ['local']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.minSize).toBeDefined();
    }
  });

  it('names every entry it refuses, and saves nothing', () => {
    const result = settingsFrom(
      {
        ...draft(),
        excludedSites: 'good.test\nnot a host!\ncom',
        fileTypes: 'zip, a/b',
        mimeTypes: 'nonsense',
      },
      current,
      ['local'],
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        excludedSites: ['not a host!', 'com'],
        fileTypes: ['a/b'],
        mimeTypes: ['nonsense'],
      },
    });
  });

  it('keeps routes to known targets, skips empty rows, and names the bad ones', () => {
    const good = settingsFrom(
      {
        ...draft(),
        routes: [
          { site: 'files.test', targetId: 'home' },
          { site: '', targetId: 'home' },
          { site: 'FILES.test', targetId: 'local' },
        ],
      },
      current,
      ['local', 'home'],
    );
    expect(good.ok && good.patch.routes).toEqual([{ site: 'files.test', targetId: 'home' }]);
    const bad = settingsFrom(
      {
        ...draft(),
        routes: [
          { site: 'files.test', targetId: 'gone' },
          { site: 'no spaces', targetId: 'home' },
        ],
      },
      current,
      ['local', 'home'],
    );
    expect(bad).toEqual({ ok: false, errors: { routes: ['files.test', 'no spaces'] } });
  });

  it('carries every switch, and keeps the parts of the settings the form does not edit', () => {
    const result = settingsFrom(
      {
        ...draft(),
        intercept: false,
        askFirst: true,
        refresh: false,
        mirrors: true,
        bypassKey: 'shift',
      },
      current,
      ['local'],
    );
    expect(result.ok && result.patch.rules).toMatchObject({
      intercept: false,
      askFirst: true,
      bypassKey: 'shift',
    });
    expect(result.ok && result.patch.preferences).toMatchObject({ refresh: false, mirrors: true });
  });
});
