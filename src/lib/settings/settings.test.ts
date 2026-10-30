import { describe, expect, it } from 'vitest';
import { memoryArea } from '../storage/area';
import { migrateSettings, SettingsTooNewError, type Migration } from './migrate';
import { adoptImported } from './import';
import { normalizeFileType, normalizeMimeType, normalizeSite, parseSettings } from './parse';
import { defaultSettings } from './schema';
import {
  SecretStore,
  SETTINGS_KEY,
  SettingsImportError,
  SettingsStore,
  withoutTarget,
  withRemoteTarget,
} from './store';
import { isLoopbackHost, normalizeBaseUrl } from './url';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://dlm.example.test/', 'https://dlm.example.test'],
    ['dlm.example.test:8443', 'https://dlm.example.test:8443'],
    ['http://192.168.1.5:17171/dlm/', 'http://192.168.1.5:17171/dlm'],
    ['  HTTPS://Example.TEST  ', 'https://example.test'],
    ['https://example.test/a?x=1#y', 'https://example.test/a'],
  ])('%s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    ['', 'empty'],
    ['ftp://example.test', 'scheme'],
    ['https://user:pw@example.test', 'credentials'],
    ['https://', 'invalid'],
  ])('refuses %j as %s', (input, problem) => {
    expect(normalizeBaseUrl(input)).toEqual({ ok: false, problem });
  });

  it('knows loopback names', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'app.localhost'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['example.test', '10.0.0.1', '1270.0.0.1'])
      expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('parseSettings', () => {
  it('gives the defaults for nothing or for rubbish', () => {
    expect(parseSettings(undefined)).toEqual(defaultSettings());
    expect(parseSettings('x')).toEqual(defaultSettings());
    expect(parseSettings([])).toEqual(defaultSettings());
  });

  it('keeps valid values and repairs the rest field by field', () => {
    const s = parseSettings({
      version: 1,
      activeTargetId: 'gone',
      targets: [
        { id: 'home', kind: 'remote', name: ' Home ', url: 'https://dlm.example.test/' },
        { id: 'home', kind: 'remote', name: 'dup', url: 'https://other.test' },
        { id: 'bad', kind: 'remote', name: 'x', url: 'ftp://nope' },
        { id: 'local', kind: 'remote', name: 'x', url: 'https://x.test' },
        'junk',
      ],
      rules: {
        minSizeBytes: -5,
        excludedSites: ['https://Example.test/a', '*.cdn.test', 'example.test', 3, '!!'],
        alwaysSites: ['*.Keep.test', 'nope!'],
        fileTypes: ['.ZIP', '*.pdf', 'a/b', ''],
        mimeTypes: ['Video/MP4; charset=binary', 'audio/', 'not a type'],
        bypassKey: 'ctrl',
        privateWindows: true,
      },
      preferences: { badge: 'yes', notifications: false },
    });
    expect(s.targets).toEqual([
      { id: 'local', kind: 'local' },
      { id: 'home', kind: 'remote', name: 'Home', url: 'https://dlm.example.test' },
    ]);
    expect(s.activeTargetId).toBe('local');
    expect(s.rules).toEqual({
      intercept: true,
      minSizeBytes: 1_000_000,
      excludedSites: ['example.test', 'cdn.test'],
      alwaysSites: ['keep.test'],
      fileTypes: ['zip', 'pdf'],
      mimeTypes: ['video/mp4', 'audio/'],
      bypassKey: 'alt',
      askFirst: false,
      privateWindows: true,
    });
    expect(s.preferences).toEqual({
      badge: true,
      notifications: false,
      mirrors: false,
      refresh: true,
    });
    expect(s.routes).toEqual([]);
  });

  it('normalises sites, file types and MIME types', () => {
    expect(normalizeSite('HTTPS://www.Example.test:8080/x?y')).toBe('www.example.test');
    expect(normalizeSite('')).toBeUndefined();
    expect(normalizeFileType(' *.Tar.Gz ')).toBeUndefined();
    expect(normalizeFileType('.ZIP')).toBe('zip');
    expect(normalizeMimeType(' Text/Plain ; charset=utf-8 ')).toBe('text/plain');
    expect(normalizeMimeType('Video/')).toBe('video/');
  });

  it('reads a version 1 file as the current rules, with the new lists empty', () => {
    const stored = migrateSettings({
      version: 1,
      rules: { askFirst: true, excludedSites: ['example.test'] },
    });
    const settings = parseSettings(stored);
    expect(settings.version).toBe(4);
    expect(settings.rules.askFirst).toBe(true);
    expect(settings.rules.excludedSites).toEqual(['example.test']);
    expect(settings.rules.alwaysSites).toEqual([]);
    expect(settings.rules.fileTypes).toEqual([]);
    expect(settings.rules.mimeTypes).toEqual([]);
  });
});

describe('migrateSettings', () => {
  const steps: Record<number, Migration> = {
    1: (old) => ({ ...old, two: true }),
    2: (old) => ({ ...old, three: true }),
  };

  it('runs every step from the stored version to the current one', () => {
    expect(migrateSettings({ version: 1, keep: 1 }, steps, 3)).toEqual({
      version: 3,
      keep: 1,
      two: true,
      three: true,
    });
    expect(migrateSettings({ version: 2 }, steps, 3)).toEqual({ version: 3, three: true });
  });

  it('counts data without a version as the first', () => {
    expect(migrateSettings({}, steps, 2)).toEqual({ version: 2, two: true });
  });

  it('refuses data from a newer version, and a missing step', () => {
    expect(() => migrateSettings({ version: 9 }, steps, 3)).toThrow(SettingsTooNewError);
    expect(() => migrateSettings({ version: 1 }, {}, 2)).toThrow(/No migration/);
  });

  it('passes through what is not an object', () => {
    expect(migrateSettings('x')).toBe('x');
  });
});

describe('SettingsStore', () => {
  it('reads the defaults, saves updates and keeps them valid', async () => {
    const store = new SettingsStore(memoryArea());
    expect(await store.get()).toEqual(defaultSettings());
    const next = await store.update((s) => ({
      ...s,
      rules: { ...s.rules, minSizeBytes: -1, askFirst: true },
    }));
    expect(next.rules.minSizeBytes).toBe(1_000_000);
    expect((await store.get()).rules.askFirst).toBe(true);
  });

  it('does not lose changes made at the same time', async () => {
    const store = new SettingsStore(memoryArea());
    await Promise.all([
      store.update((s) =>
        withRemoteTarget(s, { id: 'a', kind: 'remote', name: 'A', url: 'https://a.test' }),
      ),
      store.update((s) =>
        withRemoteTarget(s, { id: 'b', kind: 'remote', name: 'B', url: 'https://b.test' }),
      ),
      store.update((s) => ({ ...s, preferences: { ...s.preferences, badge: false } })),
    ]);
    const s = await store.get();
    expect(s.targets.map((t) => t.id)).toEqual(['local', 'a', 'b']);
    expect(s.preferences.badge).toBe(false);
  });

  it('falls back to the local target when the active one is removed', async () => {
    const store = new SettingsStore(memoryArea());
    await store.update((s) => ({
      ...withRemoteTarget(s, { id: 'a', kind: 'remote', name: 'A', url: 'https://a.test' }),
      activeTargetId: 'a',
    }));
    const s = await store.update((c) => withoutTarget(c, 'a'));
    expect(s.activeTargetId).toBe('local');
    expect(withoutTarget(s, 'local')).toBe(s);
  });

  it('refuses settings of a newer version and keeps working on damaged ones', async () => {
    const newer = new SettingsStore(memoryArea({ [SETTINGS_KEY]: { version: 5 } }));
    await expect(newer.get()).rejects.toBeInstanceOf(SettingsTooNewError);
    const damaged = new SettingsStore(memoryArea({ [SETTINGS_KEY]: { targets: 7, rules: 'x' } }));
    expect(await damaged.get()).toEqual(defaultSettings());
  });

  it('exports without secrets and imports what it exported', async () => {
    const area = memoryArea();
    const store = new SettingsStore(area);
    const secrets = new SecretStore(area);
    await store.update((s) =>
      withRemoteTarget(s, { id: 'a', kind: 'remote', name: 'A', url: 'https://a.test' }),
    );
    await secrets.set('a', 'dlmt_secretsecret123');
    const text = await store.export();
    expect(text).not.toContain('dlmt_');
    expect(text).toContain('https://a.test');

    const other = new SettingsStore(memoryArea());
    // A server this browser does not know yet comes in with a new id (and so without a token).
    const imported = await other.import(text, () => 'minted');
    expect(imported.targets.map((t) => t.id)).toEqual(['local', 'minted']);
    expect(await new SecretStore(memoryArea()).has('a')).toBe(false);
  });

  it('rejects bad import files without changing anything', async () => {
    const store = new SettingsStore(memoryArea());
    await store.update((s) => ({ ...s, preferences: { ...s.preferences, badge: false } }));
    await expect(store.import('{nope')).rejects.toMatchObject({ reason: 'not-json' });
    await expect(store.import('[1]')).rejects.toMatchObject({ reason: 'not-settings' });
    await expect(store.import('{"version":9}')).rejects.toMatchObject({ reason: 'too-new' });
    await expect(store.import('{nope')).rejects.toBeInstanceOf(SettingsImportError);
    expect((await store.get()).preferences.badge).toBe(false);
  });
});

describe('SecretStore', () => {
  it('keeps a token per target', async () => {
    const secrets = new SecretStore(memoryArea());
    await Promise.all([secrets.set('local', 't1'), secrets.set('a', 't2')]);
    expect(await secrets.get('local')).toBe('t1');
    expect(await secrets.has('a')).toBe(true);
    await secrets.remove('a');
    expect(await secrets.get('a')).toBeUndefined();
    expect(await secrets.get('local')).toBe('t1');
  });
});

describe('adoptImported', () => {
  const known = parseSettings({
    targets: [{ id: 'a', kind: 'remote', name: 'A', url: 'https://a.test' }],
    activeTargetId: 'a',
  });
  const incoming = (url: string, routes = true) =>
    parseSettings({
      targets: [{ id: 'a', kind: 'remote', name: 'A', url }],
      activeTargetId: 'a',
      routes: routes ? [{ site: 'example.test', targetId: 'a' }] : [],
    });

  it('keeps a server whose address is the same', () => {
    const next = adoptImported(known, incoming('https://a.test'), () => 'new');
    expect(next.targets.map((t) => t.id)).toEqual(['local', 'a']);
    expect(next.activeTargetId).toBe('a');
    expect(next.routes).toHaveLength(1);
  });

  it('gives a server with another address a new id, no activity and no routes', () => {
    const next = adoptImported(known, incoming('https://evil.test'), () => 'new');
    expect(next.targets.map((t) => t.id)).toEqual(['local', 'new']);
    expect(next.activeTargetId).toBe('local');
    expect(next.routes).toEqual([]);
  });
});

describe('originPattern', () => {
  it('has no port and no path', async () => {
    const { originPattern } = await import('./url');
    expect(originPattern('http://127.0.0.1:50123')).toBe('http://127.0.0.1/*');
    expect(originPattern('https://dlm.example.test:8443/prefix')).toBe(
      'https://dlm.example.test/*',
    );
  });
});

describe('site names', () => {
  it.each([
    ['example.com.', 'example.com'],
    ['*.Example.COM', 'example.com'],
    ['https://www.example.com:8443/a?b#c', 'www.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('%s is %s', (typed, expected) => {
    expect(normalizeSite(typed)).toBe(expected);
  });

  it.each(['com', '.', 'a b.test', 'exa$mple.test', '[::1]', ''])('refuses %j', (typed) => {
    expect(normalizeSite(typed)).toBeUndefined();
  });

  it('matches a host with a trailing dot against a rule', async () => {
    const { decide } = await import('../intercept/rules');
    const rules = { ...defaultSettings().rules, excludedSites: ['example.com'] };
    const decision = decide(rules, {
      url: 'https://example.com./a.zip',
      incognito: false,
      altKey: false,
      shiftKey: false,
      own: false,
    });
    expect(decision).toEqual({ action: 'leave', reason: 'site' });
  });
});

describe('settings written by earlier versions', () => {
  const v2 = {
    version: 2,
    activeTargetId: 'local',
    targets: [{ id: 'local', kind: 'local' }],
    rules: {
      intercept: false,
      minSizeBytes: 2048,
      excludedSites: ['a.test'],
      alwaysSites: ['b.test'],
    },
    preferences: { badge: false, notifications: true },
  };
  const v3 = {
    ...v2,
    version: 3,
    targets: [
      { id: 'local', kind: 'local' },
      { id: 'home', kind: 'remote', name: 'Home', url: 'https://dlm.example.test' },
    ],
    routes: [{ site: 'files.test', targetId: 'home' }],
    preferences: { badge: false, notifications: true, mirrors: true },
  };

  it('reads version 2: keeps what was set, and fills in routes, mirrors and the expired-link switch', () => {
    const s = parseSettings(migrateSettings(v2));
    expect(s.version).toBe(4);
    expect(s.rules).toMatchObject({
      intercept: false,
      minSizeBytes: 2048,
      excludedSites: ['a.test'],
      alwaysSites: ['b.test'],
    });
    expect(s.routes).toEqual([]);
    expect(s.preferences).toEqual({
      badge: false,
      notifications: true,
      mirrors: false,
      refresh: true,
    });
  });

  it('reads version 3: keeps routes and mirrors, and turns the expired-link switch on', () => {
    const s = parseSettings(migrateSettings(v3));
    expect(s.version).toBe(4);
    expect(s.routes).toEqual([{ site: 'files.test', targetId: 'home' }]);
    expect(s.preferences).toEqual({
      badge: false,
      notifications: true,
      mirrors: true,
      refresh: true,
    });
  });

  it('reads version 1 data as well, through every step', () => {
    const s = parseSettings(migrateSettings({ version: 1, rules: { askFirst: true } }));
    expect(s.rules.askFirst).toBe(true);
    expect(s.version).toBe(4);
  });
});
