import { describe, expect, it } from 'vitest';
import { atLeast, checkCompatibility, parseVersion } from './compat';
import { classifyNativeError, HOST_NAME, NativeHost, type NativeRuntime } from './host';

function host(reply: () => Promise<unknown>, timeoutMs?: number) {
  const sent: { host: string; message: unknown }[] = [];
  const runtime: NativeRuntime = {
    sendNativeMessage: (name, message) => {
      sent.push({ host: name, message });
      return reply();
    },
  };
  return { sent, native: new NativeHost(runtime, timeoutMs === undefined ? {} : { timeoutMs }) };
}

const ok = (extra: Record<string, unknown>) => () =>
  Promise.resolve({ type: 'connect', ok: true, ...extra });

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v1.2.3-rc.1')).toEqual([1, 2, 3]);
    expect(parseVersion('dev')).toBeUndefined();
    expect(atLeast('0.6.0', '0.6.0')).toBe(true);
    expect(atLeast('0.5.9', '0.6.0')).toBe(false);
    expect(atLeast('1.0.0', '0.6.0')).toBe(true);
    expect(atLeast('dev', '0.6.0')).toBe(true);
  });

  it('judges compatibility from the host and from health', () => {
    expect(checkCompatibility({ version: '0.6.0', apiVersion: 1 })).toEqual({ ok: true });
    expect(checkCompatibility({ version: '0.5.0', apiVersion: 1 })).toMatchObject({
      ok: false,
      reason: 'daemon-too-old',
    });
    expect(checkCompatibility({ apiVersion: 0 })).toMatchObject({ reason: 'daemon-too-old' });
    expect(checkCompatibility({ version: '0.7.0', apiVersion: 2, minClientApi: 2 })).toEqual({
      ok: false,
      reason: 'extension-too-old',
      requiredApi: 2,
    });
    expect(checkCompatibility({ version: '0.7.0', apiVersion: 2, minClientApi: 1 })).toEqual({
      ok: true,
    });
  });
});

describe('classifyNativeError', () => {
  it.each([
    ['Specified native messaging host not found.', 'host-not-installed'],
    ['No such native application dev.sabadia.dlm', 'host-not-installed'],
    ['Access to the specified native messaging host is forbidden.', 'host-not-allowed'],
    ['Native host has exited.', 'host-failed'],
    ['Error when communicating with the native messaging host.', 'host-failed'],
  ])('%s', (text, kind) => {
    expect(classifyNativeError(text)).toBe(kind);
  });
});

describe('NativeHost.connect', () => {
  it('finds a running daemon', async () => {
    const { native, sent } = host(
      ok({
        baseUrl: 'http://127.0.0.1:50123',
        running: true,
        version: '0.6.0',
        apiVersion: 1,
        tlsFingerprint: 'sha256:ab',
      }),
    );
    expect(await native.connect()).toEqual({
      state: 'found',
      baseUrl: 'http://127.0.0.1:50123',
      version: '0.6.0',
      apiVersion: 1,
      tlsFingerprint: 'sha256:ab',
    });
    expect(sent).toEqual([{ host: HOST_NAME, message: { type: 'connect' } }]);
  });

  it('says the app is not running, keeping the last known address', async () => {
    const { native } = host(ok({ baseUrl: 'http://127.0.0.1:17171', running: false }));
    expect(await native.connect()).toEqual({
      state: 'app-not-running',
      lastKnownBaseUrl: 'http://127.0.0.1:17171',
    });
    expect(await host(ok({ running: false })).native.connect()).toEqual({
      state: 'app-not-running',
    });
  });

  it('flags an old daemon, with or without an API version', async () => {
    const old = await host(
      ok({ baseUrl: 'http://127.0.0.1:1', running: true, version: '0.5.0', apiVersion: 1 }),
    ).native.connect();
    expect(old).toMatchObject({
      state: 'incompatible',
      compatibility: { reason: 'daemon-too-old' },
      version: '0.5.0',
    });
    const bare = await host(
      ok({ baseUrl: 'http://127.0.0.1:1', running: true, version: '0.6.0' }),
    ).native.connect();
    expect(bare).toMatchObject({ state: 'incompatible' });
    // A current daemon found by its address may leave the API version out; that is not "too old".
    const current = await host(
      ok({ baseUrl: 'http://127.0.0.1:1', running: true, version: '0.7.0' }),
    ).native.connect();
    expect(current).toMatchObject({ state: 'found' });
  });

  it('maps browser errors to states', async () => {
    const missing = await host(() =>
      Promise.reject(new Error('Specified native messaging host not found.')),
    ).native.connect();
    expect(missing).toMatchObject({ state: 'host-not-installed' });
    const forbidden = await host(() =>
      Promise.reject(new Error('Access to the specified native messaging host is forbidden.')),
    ).native.connect();
    expect(forbidden).toMatchObject({ state: 'host-not-allowed' });
    const exited = await host(() =>
      Promise.reject(new Error('Native host has exited.')),
    ).native.connect();
    expect(exited).toMatchObject({ state: 'host-failed' });
  });

  it('maps the host refusing the extension', async () => {
    const refused = await host(() =>
      Promise.resolve({
        ok: false,
        error: 'origin_not_allowed',
        message: 'chrome-extension://x/ is not allowed',
      }),
    ).native.connect();
    expect(refused).toMatchObject({ state: 'host-not-allowed' });
    const other = await host(() =>
      Promise.resolve({ ok: false, error: 'boom', message: 'dlmt_AbCdEf0123456789xyz went wrong' }),
    ).native.connect();
    expect(other).toMatchObject({ state: 'host-failed', message: '*** went wrong' });
  });

  it('times out when the host never answers', async () => {
    const result = await host(() => new Promise(() => undefined), 20).native.connect();
    expect(result).toMatchObject({ state: 'timeout' });
  });

  it('rejects an unreadable reply', async () => {
    expect(await host(() => Promise.resolve(undefined)).native.connect()).toMatchObject({
      state: 'host-failed',
    });
  });

  it('pings', async () => {
    expect(await host(() => Promise.resolve({ type: 'ping', ok: true })).native.ping()).toBe(true);
    expect(await host(() => Promise.reject(new Error('nope'))).native.ping()).toBe(false);
  });
});
