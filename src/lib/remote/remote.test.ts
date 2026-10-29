import { describe, expect, it } from 'vitest';
import type { Health } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import { RingLog } from '../log/log';
import { SecretStore, SettingsStore } from '../settings/store';
import { memoryArea } from '../storage/area';
import { RemoteService, warningsFor, type RemoteProbe } from './service';

const health: Health = {
  status: 'ok',
  version: '0.6.0',
  apiVersion: 1,
  minClientApi: 1,
  authenticated: true,
};

function setup(probe: Partial<RemoteProbe> = {}) {
  const local = memoryArea();
  const seen: { url: string; token: string }[] = [];
  let changes = 0;
  let n = 0;
  const service = new RemoteService({
    settings: new SettingsStore(local),
    secrets: new SecretStore(local),
    client: (url, token) => {
      seen.push({ url, token });
      return {
        health: probe.health ?? (() => Promise.resolve(health)),
        whoami: probe.whoami ?? (() => Promise.resolve({ scope: 'extension' })),
      };
    },
    log: new RingLog(memoryArea()),
    changed: () => {
      changes += 1;
    },
    newId: () => `r${(n += 1)}`,
  });
  return { service, local, seen, changes: () => changes };
}

describe('warningsFor', () => {
  it('warns about plain http to another computer only', () => {
    expect(warningsFor('http://192.168.1.5:17171')).toEqual(['plain-http']);
    expect(warningsFor('https://dlm.example.test')).toEqual([]);
    expect(warningsFor('http://127.0.0.1:17171')).toEqual([]);
    expect(warningsFor('http://localhost:17171')).toEqual([]);
  });
});

describe('RemoteService.test', () => {
  it('trims and normalises what was typed, and stores nothing', async () => {
    const { service, seen, local } = setup();
    expect(await service.test({ url: ' Dlm.Example.test/ ', token: ' tok ' })).toEqual({
      ok: true,
      version: '0.6.0',
      warnings: [],
    });
    expect(seen).toEqual([{ url: 'https://dlm.example.test', token: 'tok' }]);
    expect(await local.get('settings')).toBeUndefined();
  });

  it('carries the plain-http warning', async () => {
    const { service } = setup();
    expect(await service.test({ url: 'http://10.0.0.2:17171', token: 't' })).toMatchObject({
      ok: true,
      warnings: ['plain-http'],
    });
  });

  it.each([
    ['', 'empty'],
    ['ftp://x.test', 'scheme'],
    ['https://u:p@x.test', 'credentials'],
  ])('refuses the address %j', async (url, detail) => {
    expect(await setup().service.test({ url, token: 't' })).toEqual({
      ok: false,
      problem: 'invalid-url',
      detail,
    });
  });

  it('tells a wrong token, an unreachable server (with the https hint) and an old DLM', async () => {
    const wrong = setup({ whoami: () => Promise.reject(new ApiError(401, undefined, 'no')) });
    expect(await wrong.service.test({ url: 'https://x.test', token: 't' })).toEqual({
      ok: false,
      problem: 'unauthorized',
    });

    const down = setup({ health: () => Promise.reject(new NetworkError('Failed to fetch')) });
    expect(await down.service.test({ url: 'https://x.test', token: 't' })).toMatchObject({
      ok: false,
      problem: 'unreachable',
      https: true,
    });
    expect(await down.service.test({ url: 'http://x.test', token: 't' })).toMatchObject({
      problem: 'unreachable',
      https: false,
    });

    const old = setup({ health: () => Promise.resolve({ ...health, version: '0.5.0' }) });
    expect(await old.service.test({ url: 'https://x.test', token: 't' })).toMatchObject({
      ok: false,
      problem: 'incompatible',
    });
  });

  it('turns anything else into a plain failure without secrets', async () => {
    const s = setup({
      health: () => Promise.reject(new Error('boom for dlmt_AbCdEf0123456789xyz')),
    });
    const r = await s.service.test({ url: 'https://x.test', token: 't' });
    expect(r).toMatchObject({ ok: false, problem: 'failed' });
  });
});

describe('RemoteService.add / list / remove', () => {
  it('saves a working server with its token apart from the settings', async () => {
    const { service, local, changes } = setup();
    const added = await service.add({
      name: ' Home ',
      url: 'https://dlm.example.test/',
      token: 'tok',
    });
    expect(added).toEqual({ ok: true, id: 'r1', warnings: [] });
    expect(JSON.stringify(await local.get('settings'))).not.toContain('tok');
    expect(await new SecretStore(local).get('r1')).toBe('tok');
    expect(await service.list()).toEqual([
      { id: 'local', kind: 'local', name: 'DLM on this computer', hasToken: false, active: true },
      {
        id: 'r1',
        kind: 'remote',
        name: 'Home',
        url: 'https://dlm.example.test',
        hasToken: true,
        active: false,
      },
    ]);
    expect(changes()).toBe(1);
  });

  it('saves nothing when the test fails', async () => {
    const { service, local } = setup({
      whoami: () => Promise.reject(new ApiError(401, undefined, 'no')),
    });
    expect(await service.add({ name: 'x', url: 'https://x.test', token: 't' })).toMatchObject({
      ok: false,
    });
    expect(await new SecretStore(local).has('r1')).toBe(false);
    expect((await service.list()).map((t) => t.id)).toEqual(['local']);
  });

  it('names a server by its address when no name is given', async () => {
    const { service } = setup();
    await service.add({ name: '  ', url: 'https://dlm.example.test', token: 't' });
    expect((await service.list())[1]?.name).toBe('https://dlm.example.test');
  });

  it('makes a server active, and falls back to the local DLM when it is removed', async () => {
    const { service, local } = setup();
    await service.add({ name: 'Home', url: 'https://dlm.example.test', token: 't' });
    await service.setActive('r1');
    expect((await service.list()).find((t) => t.active)?.id).toBe('r1');
    await service.setActive('nope');
    expect((await service.list()).find((t) => t.active)?.id).toBe('r1');
    await service.remove('r1');
    expect((await service.list()).map((t) => [t.id, t.active])).toEqual([['local', true]]);
    expect(await new SecretStore(local).has('r1')).toBe(false);
  });

  it('never removes the local DLM', async () => {
    const { service } = setup();
    await service.remove('local');
    expect((await service.list()).map((t) => t.id)).toEqual(['local']);
  });

  it('replaces a token only when the server accepts the new one', async () => {
    const { service, local } = setup();
    await service.add({ name: 'Home', url: 'https://dlm.example.test', token: 'old' });
    expect(await service.replaceToken('r1', 'new')).toMatchObject({ ok: true });
    expect(await new SecretStore(local).get('r1')).toBe('new');
    expect(await service.replaceToken('local', 'x')).toMatchObject({ ok: false });
  });
});
