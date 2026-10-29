import { describe, expect, it } from 'vitest';
import { RingLog } from '../log/log';
import { NativeHost, type NativeRuntime } from '../native/host';
import { SecretStore } from '../settings/store';
import { memoryArea } from '../storage/area';
import { detectBrowser } from './browser';
import { PairingService } from './service';

const TOKEN = 'dlmt_AbCdEf0123456789xyz';
const EXPIRES = '2026-10-30T12:02:00Z';

/** A fake host that plays the daemon's side of pairing. */
function fakeHost() {
  const state = { status: 'pending', tokenTaken: false, sent: [] as Record<string, unknown>[] };
  const runtime: NativeRuntime = {
    sendNativeMessage: (_name, message) => {
      const m = message as Record<string, unknown>;
      state.sent.push(m);
      if (m.type === 'pair') {
        return Promise.resolve({
          ok: true,
          type: 'pair',
          pairingId: 'p1',
          status: 'pending',
          code: '482913',
          expiresAt: EXPIRES,
        });
      }
      if (m.type === 'pair.status') {
        const reply: Record<string, unknown> = {
          ok: true,
          type: 'pair.status',
          pairingId: 'p1',
          status: state.status,
          code: '482913',
          expiresAt: EXPIRES,
        };
        if (state.status === 'approved' && !state.tokenTaken) {
          reply.token = TOKEN;
          state.tokenTaken = true;
        }
        return Promise.resolve(reply);
      }
      return Promise.reject(new Error('unexpected'));
    },
  };
  return { state, host: new NativeHost(runtime) };
}

function setup(now = Date.parse('2026-10-30T12:00:00Z')) {
  const { state, host } = fakeHost();
  const local = memoryArea();
  const session = memoryArea();
  const secrets = new SecretStore(local);
  const log = new RingLog(session);
  const make = () =>
    new PairingService({
      host,
      secrets,
      area: session,
      browser: 'chrome',
      version: '0.1.0',
      log,
      now: () => now,
    });
  return { state, secrets, session, log, make, service: make() };
}

describe('PairingService', () => {
  it('asks, shows the code, and stores the token when the app allows it', async () => {
    const { service, state, secrets, log } = setup();
    const started = await service.start();
    expect(started).toEqual({ phase: 'pending', code: '482913', expiresAt: Date.parse(EXPIRES) });
    expect(state.sent[0]).toEqual({
      type: 'pair',
      name: 'Chrome extension',
      browser: 'chrome',
      version: '0.1.0',
    });
    expect(await service.poll()).toMatchObject({ phase: 'pending' });
    expect(await secrets.get('local')).toBeUndefined();

    state.status = 'approved';
    expect(await service.poll()).toEqual({ phase: 'approved' });
    expect(await secrets.get('local')).toBe(TOKEN);
    expect(await service.view()).toEqual({ phase: 'idle' });

    const text = JSON.stringify(await log.read());
    expect(text).not.toContain('dlmt_');
    expect(text).toContain('paired');
  });

  it('reports a refusal and an expiry, and forgets the pairing', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const { service, state, secrets } = setup();
      await service.start();
      state.status = status;
      expect(await service.poll()).toEqual({ phase: status });
      expect(await service.view()).toEqual({ phase: 'idle' });
      expect(await secrets.get('local')).toBeUndefined();
    }
  });

  it('carries on after the worker restarted', async () => {
    const { make, state, secrets } = setup();
    await make().start();
    const restarted = make(); // a new instance over the same storage
    expect(await restarted.view()).toMatchObject({ phase: 'pending', code: '482913' });
    state.status = 'approved';
    expect(await restarted.poll()).toEqual({ phase: 'approved' });
    expect(await secrets.get('local')).toBe(TOKEN);
  });

  it('notices a pairing that ran out while nobody looked', async () => {
    const { session, log } = setup();
    const late = new PairingService({
      host: fakeHost().host,
      secrets: new SecretStore(memoryArea()),
      area: session,
      browser: 'chrome',
      version: '0.1.0',
      log,
      now: () => Date.parse('2026-10-30T12:00:00Z'),
    });
    await late.start();
    const later = new PairingService({
      host: fakeHost().host,
      secrets: new SecretStore(memoryArea()),
      area: session,
      browser: 'chrome',
      version: '0.1.0',
      log,
      now: () => Date.parse('2026-10-30T12:03:00Z'),
    });
    expect(await later.view()).toEqual({ phase: 'expired' });
    expect(await later.view()).toEqual({ phase: 'idle' });
  });

  it('says so when the token was already taken, and never loses the first one', async () => {
    const { service, state, secrets } = setup();
    await service.start();
    state.status = 'approved';
    state.tokenTaken = true; // someone else read it
    const view = await service.poll();
    expect(view).toMatchObject({ phase: 'error' });
    expect(await secrets.get('local')).toBeUndefined();
  });

  it('turns host failures into an error view, without secrets', async () => {
    const runtime: NativeRuntime = {
      sendNativeMessage: () =>
        Promise.reject(new Error('Specified native messaging host not found.')),
    };
    const session = memoryArea();
    const service = new PairingService({
      host: new NativeHost(runtime),
      secrets: new SecretStore(memoryArea()),
      area: session,
      browser: 'firefox',
      version: '0.1.0',
      log: new RingLog(session),
    });
    expect(await service.start()).toEqual({
      phase: 'error',
      message: 'Specified native messaging host not found.',
    });
    expect(await service.poll()).toEqual({ phase: 'idle' });
  });

  it('can be cancelled', async () => {
    const { service } = setup();
    await service.start();
    expect(await service.cancel()).toEqual({ phase: 'idle' });
    expect(await service.view()).toEqual({ phase: 'idle' });
  });
});

describe('detectBrowser', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', false, 'firefox'],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      false,
      'chrome',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
      false,
      'edge',
    ],
    ['Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36 OPR/110.0.0.0', false, 'opera'],
    ['Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36 Vivaldi/7.0', false, 'vivaldi'],
    ['Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36', true, 'brave'],
    [
      'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Chromium/156.0 Chrome/156.0 Safari/537.36',
      false,
      'chromium',
    ],
    ['curl/8', false, 'other'],
  ])('%s', (ua, brave, expected) => {
    expect(detectBrowser(ua, brave)).toBe(expected);
  });
});
