import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../api/errors';
import type { Health } from '../api/client';
import { RingLog } from '../log/log';
import type { Discovery } from '../native/host';
import { LOCAL_TARGET, type RemoteTarget } from '../settings/schema';
import { SecretStore, SettingsStore, withRemoteTarget } from '../settings/store';
import { memoryArea } from '../storage/area';
import { resolveConnection, type ProbeClient, type ResolveDeps } from './resolve';
import { ConnectionService, describeState, type ActionApi } from './service';
import { badgeFor, type ConnectionState } from './state';

const health = (over: Partial<Health> = {}): Health => ({
  status: 'ok',
  version: '0.6.0',
  apiVersion: 1,
  minClientApi: 1,
  authenticated: true,
  ...over,
});
const found: Discovery = {
  state: 'found',
  baseUrl: 'http://127.0.0.1:50123',
  version: '0.6.0',
  apiVersion: 1,
};

function deps(
  over: Partial<ResolveDeps> & {
    health?: () => Promise<Health>;
    whoami?: () => Promise<{ scope: string }>;
  } = {},
): ResolveDeps {
  return {
    target: LOCAL_TARGET,
    token: 'dlmt_AbCdEf0123456789xyz',
    discover: () => Promise.resolve(found),
    pairing: () => Promise.resolve({ phase: 'idle' }),
    hasAccess: () => Promise.resolve(true),
    client: () => ({
      health: over.health ?? (() => Promise.resolve(health())),
      whoami: over.whoami ?? (() => Promise.resolve({ scope: 'extension' })),
    }),
    ...over,
  };
}

describe('resolveConnection (local)', () => {
  it('connects', async () => {
    expect(await resolveConnection(deps())).toEqual({
      kind: 'connected',
      targetId: 'local',
      baseUrl: 'http://127.0.0.1:50123',
      version: '0.6.0',
    });
  });

  it.each<[Discovery, ConnectionState['kind']]>([
    [{ state: 'host-not-installed', message: 'x' }, 'host-not-installed'],
    [{ state: 'host-not-allowed', message: 'x' }, 'host-not-allowed'],
    [{ state: 'host-failed', message: 'x' }, 'host-failed'],
    [{ state: 'timeout', message: 'x' }, 'host-failed'],
    [{ state: 'app-not-running' }, 'app-not-running'],
    [
      {
        state: 'incompatible',
        compatibility: { ok: false, reason: 'daemon-too-old', minVersion: '0.6.0' },
      },
      'incompatible',
    ],
  ])('maps discovery %j to %s', async (discovery, kind) => {
    expect(
      (await resolveConnection(deps({ discover: () => Promise.resolve(discovery) }))).kind,
    ).toBe(kind);
  });

  it('asks for pairing when there is no token, and shows a pending pairing', async () => {
    expect((await resolveConnection(deps({ token: undefined }))).kind).toBe('needs-pairing');
    const pending = deps({
      token: undefined,
      pairing: () => Promise.resolve({ phase: 'pending', code: '123456', expiresAt: 1 }),
    });
    expect((await resolveConnection(pending)).kind).toBe('pairing');
  });

  it('says the token was revoked on a 401', async () => {
    const state = await resolveConnection(
      deps({ whoami: () => Promise.reject(new ApiError(401, undefined, 'unauthorized')) }),
    );
    expect(state.kind).toBe('token-revoked');
  });

  it('flags a daemon that needs a newer extension, from health', async () => {
    const state = await resolveConnection(
      deps({ health: () => Promise.resolve(health({ apiVersion: 2, minClientApi: 2 })) }),
    );
    expect(state).toEqual({
      kind: 'incompatible',
      compatibility: { ok: false, reason: 'extension-too-old', requiredApi: 2 },
    });
  });

  it('says the address is unreachable when the host found DLM but the browser cannot call it', async () => {
    const state = await resolveConnection(
      deps({
        discover: () => Promise.resolve({ ...found, baseUrl: 'https://127.0.0.1:50123' }),
        health: () => Promise.reject(new NetworkError('Failed to fetch')),
      }),
    );
    expect(state).toEqual({ kind: 'local-unreachable', https: true });
  });
});

describe('browser access', () => {
  it('asks for it, for the local daemon and for remote servers, before anything else', async () => {
    const denied = { hasAccess: () => Promise.resolve(false) };
    expect(await resolveConnection(deps(denied))).toEqual({
      kind: 'access-needed',
      origin: 'http://127.0.0.1/*',
    });
    const remote: RemoteTarget = {
      id: 'home',
      kind: 'remote',
      name: 'Home',
      url: 'https://dlm.example.test:8443/x',
    };
    expect(await resolveConnection(deps({ ...denied, target: remote }))).toEqual({
      kind: 'access-needed',
      origin: 'https://dlm.example.test/*',
    });
  });
});

describe('resolveConnection (remote)', () => {
  const remote: RemoteTarget = {
    id: 'home',
    kind: 'remote',
    name: 'Home',
    url: 'https://dlm.example.test',
  };

  it('needs a token, connects, and reports unreachable servers', async () => {
    expect((await resolveConnection(deps({ target: remote, token: undefined }))).kind).toBe(
      'remote-needs-token',
    );
    expect(await resolveConnection(deps({ target: remote }))).toEqual({
      kind: 'connected',
      targetId: 'home',
      baseUrl: 'https://dlm.example.test',
      version: '0.6.0',
    });
    const down = await resolveConnection(
      deps({ target: remote, health: () => Promise.reject(new NetworkError('timed out')) }),
    );
    expect(down).toMatchObject({ kind: 'remote-unreachable', targetId: 'home' });
  });

  it('never asks the native host', async () => {
    let asked = false;
    await resolveConnection(
      deps({ target: remote, discover: () => ((asked = true), Promise.resolve(found)) }),
    );
    expect(asked).toBe(false);
  });
});

describe('badgeFor', () => {
  it('is quiet when fine, amber when DLM is away, red when something must be fixed', () => {
    expect(
      badgeFor({ kind: 'connected', targetId: 'local', baseUrl: 'x', version: '1' }, true).text,
    ).toBe('');
    expect(badgeFor({ kind: 'app-not-running' }, true)).toMatchObject({
      text: '!',
      color: '#b26a00',
    });
    expect(badgeFor({ kind: 'token-revoked' }, true)).toMatchObject({
      text: '!',
      color: '#c62828',
    });
    expect(badgeFor({ kind: 'needs-pairing' }, true).text).toBe('…');
    expect(badgeFor({ kind: 'token-revoked' }, false).text).toBe('');
  });
});

describe('describeState', () => {
  it('words the version problems', () => {
    expect(
      describeState({
        kind: 'incompatible',
        compatibility: { ok: false, reason: 'daemon-too-old', minVersion: '0.6.0' },
      }),
    ).toContain('0.6.0');
    expect(
      describeState({
        kind: 'incompatible',
        compatibility: { ok: false, reason: 'extension-too-old', requiredApi: 2 },
      }),
    ).toContain('extension');
    expect(
      describeState({ kind: 'connected', targetId: 'local', baseUrl: 'x', version: '0.6.1' }),
    ).toBe('Connected to DLM 0.6.1.');
  });
});

describe('ConnectionService', () => {
  function setup(
    discovery: () => Promise<Discovery> = () => Promise.resolve(found),
    clientHealth: () => Promise<Health> = () => Promise.resolve(health()),
  ) {
    const local = memoryArea();
    const session = memoryArea();
    const calls: string[] = [];
    const action: ActionApi = {
      setBadgeText: ({ text }) => void calls.push(`text:${text}`),
      setBadgeBackgroundColor: ({ color }) => void calls.push(`color:${color}`),
      setTitle: ({ title }) => void calls.push(`title:${title}`),
    };
    let discoveries = 0;
    const service = new ConnectionService({
      settings: new SettingsStore(local),
      secrets: new SecretStore(local),
      host: { connect: () => ((discoveries += 1), discovery()) },
      pairing: { view: () => Promise.resolve({ phase: 'idle' }) },
      area: session,
      action,
      log: new RingLog(session),
      client: (): ProbeClient => ({
        health: clientHealth,
        whoami: () => Promise.resolve({ scope: 'extension' }),
      }),
    });
    return { service, local, calls, discoveries: () => discoveries };
  }

  it('starts as checking, stores the result and paints the toolbar button', async () => {
    const { service, local, calls } = setup();
    expect((await service.get()).kind).toBe('checking');
    expect((await service.refresh()).kind).toBe('needs-pairing');
    await new SecretStore(local).set('local', 'dlmt_AbCdEf0123456789xyz');
    expect((await service.refresh()).kind).toBe('connected');
    expect((await service.get()).kind).toBe('connected');
    expect(calls).toContain('text:…');
    expect(calls.at(-1)).toBe('title:DLM: Connected to DLM 0.6.0.');
  });

  it('does not start the host again while the last address still works', async () => {
    const { service, local, discoveries } = setup();
    await new SecretStore(local).set('local', 'dlmt_AbCdEf0123456789xyz');
    await service.refresh();
    await service.refresh();
    await service.refresh();
    expect(discoveries()).toBe(1);
  });

  it('looks the daemon up again when the stored address stops working', async () => {
    let up = true;
    const { service, local, discoveries } = setup(undefined, () =>
      up ? Promise.resolve(health()) : Promise.reject(new NetworkError('down')),
    );
    await new SecretStore(local).set('local', 'dlmt_AbCdEf0123456789xyz');
    await service.refresh();
    up = false;
    const state = await service.refresh();
    expect(discoveries()).toBe(2);
    expect(state.kind).toBe('local-unreachable');
  });

  it('shares one check between callers', async () => {
    const { service, discoveries } = setup();
    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    expect(discoveries()).toBe(1);
  });

  it('follows the badge preference and survives a broken toolbar API', async () => {
    const { service, local } = setup();
    await new SettingsStore(local).update((s) => ({
      ...s,
      preferences: { ...s.preferences, badge: false },
    }));
    expect((await service.refresh()).kind).toBe('needs-pairing');
    const broken = new ConnectionService({
      settings: new SettingsStore(memoryArea()),
      secrets: new SecretStore(memoryArea()),
      host: { connect: () => Promise.resolve(found) },
      pairing: { view: () => Promise.resolve({ phase: 'idle' }) },
      area: memoryArea(),
      action: {
        setBadgeText: () => Promise.reject(new Error('no action')),
        setBadgeBackgroundColor: () => undefined,
        setTitle: () => undefined,
      },
      log: new RingLog(memoryArea()),
    });
    expect((await broken.refresh()).kind).toBe('needs-pairing');
  });

  it('uses the active remote target', async () => {
    const { service, local } = setup(() => Promise.reject(new Error('the host must not be asked')));
    const store = new SettingsStore(local);
    await store.update((s) => ({
      ...withRemoteTarget(s, {
        id: 'home',
        kind: 'remote',
        name: 'Home',
        url: 'https://dlm.example.test',
      }),
      activeTargetId: 'home',
    }));
    expect((await service.refresh()).kind).toBe('remote-needs-token');
    await new SecretStore(local).set('home', 'tok');
    expect(await service.refresh()).toMatchObject({ kind: 'connected', targetId: 'home' });
  });
});
