import { describe, expect, it } from 'vitest';
import { listen, sendMessage, senderKind, type RuntimeLike, type SenderLike } from '../lib/bus/bus';
import { memoryArea } from '../lib/storage/area';
import { StoredValue } from '../lib/storage/state';
import { createHandlers } from './handlers';
import { createServices } from './services';

const BASE = 'chrome-extension://abc/';

const noHost = { sendNativeMessage: () => Promise.reject(new Error('no host')) };

const noAction = {
  setBadgeText: () => undefined,
  setBadgeBackgroundColor: () => undefined,
  setTitle: () => undefined,
};

type Listener = Parameters<RuntimeLike['onMessage']['addListener']>[0];

/** A runtime whose `sendMessage` goes to the registered listener, as the browser would deliver it. */
function fakeRuntime(from: SenderLike = { id: 'abc', url: `${BASE}popup.html` }) {
  let listener: Listener | undefined;
  const runtime: RuntimeLike = {
    id: 'abc',
    getURL: (path) => `${BASE}${path}`,
    onMessage: {
      addListener: (l) => {
        listener = l;
      },
    },
    sendMessage: (message) =>
      new Promise((resolve) => {
        const kept = listener?.(message, from, resolve);
        if (kept !== true) resolve(undefined);
      }),
  };
  return runtime;
}

function build(sender?: SenderLike) {
  const runtime = fakeRuntime(sender);
  const services = createServices({
    local: memoryArea(),
    session: memoryArea(),
    version: '0.1.0',
    userAgent: 'UA',
    native: noHost,
    action: noAction,
  });
  listen(runtime, createHandlers(services));
  return { runtime, services };
}

describe('the message bus', () => {
  it('answers a page with the typed reply', async () => {
    const { runtime } = build();
    expect(await sendMessage(runtime, 'ext.info')).toEqual({ version: '0.1.0' });
  });

  it('builds diagnostics from what the services hold, without secrets', async () => {
    const { runtime, services } = build();
    services.log.info('test', 'paired with dlmt_AbCdEf0123456789xyz');
    await services.secrets.set('local', 'dlmt_AbCdEf0123456789xyz');
    const text = await sendMessage(runtime, 'diagnostics.get');
    expect(text).toContain('DLM extension 0.1.0');
    expect(text).toContain('paired with ***');
    expect(text).not.toContain('dlmt_');
  });

  it('clears the log', async () => {
    const { runtime, services } = build();
    services.log.info('t', 'x');
    await sendMessage(runtime, 'log.clear');
    expect(await services.log.read()).toEqual([]);
  });

  it('ignores other extensions and web pages', async () => {
    for (const sender of [
      { id: 'other', url: 'chrome-extension://other/x.html' },
      { id: 'abc', url: 'https://evil.test/' }, // our id but not our page and no tab: nothing we know
      { url: 'https://evil.test/', tab: {} },
    ]) {
      const { runtime } = build(sender);
      await expect(sendMessage(runtime, 'ext.info')).rejects.toThrow(/did not answer/);
    }
  });

  it('keeps content scripts away from handlers that do not ask for them', async () => {
    const { runtime } = build({ id: 'abc', url: 'https://example.test/', tab: { id: 1 } });
    await expect(sendMessage(runtime, 'diagnostics.get')).rejects.toThrow(/did not answer/);
  });

  it('lets a content script reach a handler that allows it', async () => {
    const runtime = fakeRuntime({ id: 'abc', url: 'https://example.test/', tab: { id: 1 } });
    listen(runtime, { 'ext.info': { fromContent: true, handle: () => ({ version: 'x' }) } });
    expect(await sendMessage(runtime, 'ext.info')).toEqual({ version: 'x' });
  });

  it('replies with a redacted error when a handler fails', async () => {
    const runtime = fakeRuntime();
    listen(runtime, {
      'ext.info': {
        handle: () => {
          throw new Error('failed for dlmt_AbCdEf0123456789xyz');
        },
      },
    });
    await expect(sendMessage(runtime, 'ext.info')).rejects.toThrow('failed for ***');
  });

  it('ignores messages that are not ours', async () => {
    const runtime = fakeRuntime();
    listen(
      runtime,
      createHandlers(
        createServices({
          local: memoryArea(),
          session: memoryArea(),
          version: '1',
          userAgent: 'u',
          native: noHost,
          action: noAction,
        }),
      ),
    );
    await expect(runtime.sendMessage({ type: 'ext.info' })).resolves.toBeUndefined();
  });

  it('tells senders apart', () => {
    const r = { id: 'abc', getURL: (p: string) => `${BASE}${p}` };
    expect(senderKind(r, { id: 'abc', url: `${BASE}options.html` })).toBe('extension-page');
    expect(senderKind(r, { id: 'abc', url: 'https://a.test/', tab: {} })).toBe('content-script');
    expect(senderKind(r, { id: 'x', url: `${BASE}options.html` })).toBe('foreign');
  });
});

describe('StoredValue', () => {
  const parse = (raw: unknown) => (typeof raw === 'number' ? raw : 0);

  it('reads the default, survives a new instance, and serialises updates', async () => {
    const area = memoryArea();
    const a = new StoredValue(area, 'n', parse);
    expect(await a.get()).toBe(0);
    await Promise.all([a.update((n) => n + 1), a.update((n) => n + 1), a.update((n) => n + 1)]);
    // A restarted worker builds a new one over the same storage.
    expect(await new StoredValue(area, 'n', parse).get()).toBe(3);
  });

  it('treats rubbish as the default', async () => {
    expect(await new StoredValue(memoryArea({ n: 'x' }), 'n', parse).get()).toBe(0);
  });
});

describe('the background lifecycle', () => {
  it('checks at startup, install and on the alarm, and makes sure the alarm exists', async () => {
    const { registerBackground, CHECK_ALARM, REFRESH_ALARM } = await import('./register');
    const listeners = {
      startup: [] as (() => void)[],
      installed: [] as (() => void)[],
      alarm: [] as ((a: { name: string }) => void)[],
    };
    const created: string[] = [];
    registerBackground(
      fakeRuntime(),
      {
        local: memoryArea(),
        session: memoryArea(),
        version: '1',
        userAgent: 'u',
        native: noHost,
        action: noAction,
      },
      {
        onStartup: { addListener: (l) => listeners.startup.push(l) },
        onInstalled: { addListener: (l) => listeners.installed.push(l) },
        alarms: {
          get: () => Promise.resolve(undefined),
          create: (name) => {
            created.push(name);
          },
          onAlarm: { addListener: (l) => listeners.alarm.push(l) },
        },
      },
    );
    expect(listeners.startup).toHaveLength(1);
    expect(listeners.installed).toHaveLength(1);
    expect(listeners.alarm).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toEqual([CHECK_ALARM, REFRESH_ALARM]);
    listeners.alarm[0]?.({ name: 'something-else' }); // ignored
  });
});
