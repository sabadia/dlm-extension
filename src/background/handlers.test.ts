import { describe, expect, it } from 'vitest';
import { listen, sendMessage, type RuntimeLike, type SenderLike } from '../lib/bus/bus';
import type { LinksService } from '../lib/links/service';
import type { MediaService } from '../lib/media/service';
import type { InterceptService } from '../lib/intercept/service';
import { withRemoteTarget } from '../lib/settings/store';
import { memoryArea } from '../lib/storage/area';
import { createHandlers } from './handlers';
import { createServices, type Services } from './services';

const BASE = 'chrome-extension://abc/';
const noHost = { sendNativeMessage: () => Promise.reject(new Error('no host')) };
const noAction = {
  setBadgeText: () => undefined,
  setBadgeBackgroundColor: () => undefined,
  setTitle: () => undefined,
};

type Listener = Parameters<RuntimeLike['onMessage']['addListener']>[0];

const PAGE: SenderLike = { id: 'abc', url: `${BASE}options.html` };
const TOP: SenderLike = { id: 'abc', url: 'https://example.test/page', tab: { id: 7 }, frameId: 0 };
const FRAME: SenderLike = { ...TOP, frameId: 3 };

function setup(patch: Partial<Services> = {}) {
  const services: Services = {
    ...createServices({
      local: memoryArea(),
      session: memoryArea(),
      version: '1',
      userAgent: 'UA',
      native: noHost,
      action: noAction,
    }),
    ...patch,
  };
  let listener: Listener | undefined;
  const runtime: RuntimeLike & { as(sender: SenderLike): RuntimeLike } = {
    id: 'abc',
    getURL: (path) => `${BASE}${path}`,
    onMessage: { addListener: (l) => (listener = l) },
    sendMessage: () => Promise.resolve(undefined),
    as: (sender) => ({
      id: 'abc',
      getURL: (path) => `${BASE}${path}`,
      onMessage: { addListener: () => undefined },
      sendMessage: (message) =>
        new Promise((resolve) => {
          const kept = listener?.(message, sender, resolve);
          if (kept !== true) resolve(undefined);
        }),
    }),
  };
  listen(runtime, createHandlers(services));
  return { services, from: (sender: SenderLike) => runtime.as(sender) };
}

describe('settings.save', () => {
  it('keeps a server added after the form was loaded', async () => {
    const { services, from } = setup();
    const stale = await services.settings.get();
    await services.settings.update((s) =>
      withRemoteTarget(s, {
        id: 'r1',
        kind: 'remote',
        name: 'Home',
        url: 'https://dlm.example.test',
      }),
    );
    await services.settings.update((s) => ({ ...s, activeTargetId: 'r1' }));
    const saved = await sendMessage(from(PAGE), 'settings.save', {
      rules: { ...stale.rules, askFirst: true },
      preferences: stale.preferences,
      routes: [],
    });
    expect(saved.rules.askFirst).toBe(true);
    expect(saved.targets.map((t) => t.id)).toEqual(['local', 'r1']);
    expect(saved.activeTargetId).toBe('r1');
  });
});

describe('settings.import', () => {
  const file = (url: string) =>
    JSON.stringify({
      version: 3,
      activeTargetId: 'r1',
      targets: [{ id: 'r1', kind: 'remote', name: 'Home', url }],
      routes: [{ site: 'example.test', targetId: 'r1' }],
    });

  async function withServer() {
    const ctx = setup();
    await ctx.services.settings.update((s) =>
      withRemoteTarget(s, {
        id: 'r1',
        kind: 'remote',
        name: 'Home',
        url: 'https://dlm.example.test',
      }),
    );
    await ctx.services.secrets.set('r1', 'dlmt_AbCdEf0123456789xyz');
    await ctx.services.secrets.set('gone', 'dlmt_OtherOtherOther123');
    return ctx;
  }

  it('does not let a file point a known server at another address and keep its token', async () => {
    const { services, from } = await withServer();
    const imported = await sendMessage(from(PAGE), 'settings.import', {
      text: file('https://evil.example'),
    });
    const evil = imported.targets.find(
      (t) => t.kind === 'remote' && t.url === 'https://evil.example',
    );
    expect(evil).toBeDefined();
    expect(evil?.id).not.toBe('r1');
    expect(await services.secrets.get(evil?.id ?? '')).toBeUndefined();
    expect(await services.secrets.has('r1')).toBe(false);
    expect(imported.activeTargetId).toBe('local');
    expect(imported.routes).toEqual([]);
  });

  it('keeps the token, the active target and the routes of a server whose address did not change', async () => {
    const { services, from } = await withServer();
    const imported = await sendMessage(from(PAGE), 'settings.import', {
      text: file('https://dlm.example.test'),
    });
    expect(imported.targets.map((t) => t.id)).toEqual(['local', 'r1']);
    expect(imported.activeTargetId).toBe('r1');
    expect(imported.routes).toHaveLength(1);
    expect(await services.secrets.get('r1')).toBe('dlmt_AbCdEf0123456789xyz');
    expect(await services.secrets.has('gone')).toBe(false); // no target of that id any more
  });

  it('answers a bad file with a sentence, not a code', async () => {
    const { from } = setup();
    await expect(sendMessage(from(PAGE), 'settings.import', { text: '{nope' })).rejects.toThrow(
      'That file is not JSON.',
    );
  });
});

describe('what a content script may ask', () => {
  const links = () => {
    const seen: string[] = [];
    return {
      seen,
      fake: {
        addDirect: (url: string) => {
          seen.push(url);
          return Promise.resolve(true);
        },
        sendMany: (urls: string[]) => {
          seen.push(...urls);
          return Promise.resolve({ ok: urls.length, failed: 0 });
        },
      } as unknown as LinksService,
    };
  };

  it('links.add takes a magnet or eD2K link from the top frame only', async () => {
    const { seen, fake } = links();
    const { from } = setup({ links: fake });
    expect(await sendMessage(from(TOP), 'links.add', { url: 'magnet:?xt=urn:btih:abc' })).toBe(
      true,
    );
    expect(await sendMessage(from(TOP), 'links.add', { url: 'ed2k://|file|a|1|h|/' })).toBe(true);
    expect(await sendMessage(from(FRAME), 'links.add', { url: 'magnet:?xt=urn:btih:def' })).toBe(
      false,
    );
    expect(await sendMessage(from(TOP), 'links.add', { url: 'https://example.test/a.zip' })).toBe(
      false,
    );
    expect(await sendMessage(from(TOP), 'links.add', { url: 'javascript:alert(1)' })).toBe(false);
    expect(seen).toEqual(['magnet:?xt=urn:btih:abc', 'ed2k://|file|a|1|h|/']);
  });

  it('links.send, from the links page, drops addresses that are not web or magnet links and caps the batch', async () => {
    const { seen, fake } = links();
    const { from } = setup({ links: fake });
    const many = Array.from({ length: 600 }, (_v, i) => `https://example.test/${i}`);
    await sendMessage(from(PAGE), 'links.send', {
      urls: ['file:///etc/passwd', 'javascript:1', 'not a url', 'magnet:?xt=x', ...many],
    });
    expect(seen).toHaveLength(500);
    expect(seen[0]).toBe('magnet:?xt=x');
    expect(seen.some((u) => u.startsWith('file:') || u.startsWith('javascript:'))).toBe(false);
  });

  it('page.hints is ignored from an iframe', async () => {
    const seen: unknown[] = [];
    const intercept = {
      noteHints: (hints: unknown) => {
        seen.push(hints);
        return Promise.resolve();
      },
    } as unknown as InterceptService;
    const { from } = setup({ intercept });
    await sendMessage(from(FRAME), 'page.hints', { hints: [] });
    expect(seen).toEqual([]);
    await sendMessage(from(TOP), 'page.hints', { hints: [] });
    expect(seen).toHaveLength(1);
  });

  it('media.scan uses the sender page address, ignores iframes, and caps what the page sent', async () => {
    const seen: { tabId: number; pageUrl: string; links: number }[] = [];
    const media = {
      scan: (tabId: number, snapshot: { pageUrl: string; links: unknown[] }) => {
        seen.push({ tabId, pageUrl: snapshot.pageUrl, links: snapshot.links.length });
        return Promise.resolve();
      },
    } as unknown as MediaService;
    const { from } = setup({ media });
    const snapshot = {
      pageUrl: 'https://victim.example/',
      protectedMedia: false,
      blobOrMse: false,
      videos: [],
      audios: [],
      links: Array.from({ length: 5000 }, () => ({ href: 'https://a.test/x.zip', text: 'x' })),
      openGraph: [],
      jsonLd: [],
    };
    await sendMessage(from(TOP), 'media.scan', { snapshot });
    await sendMessage(from(FRAME), 'media.scan', { snapshot });
    await sendMessage(from(TOP), 'media.scan', { snapshot: 'nonsense' as never });
    expect(seen).toEqual([{ tabId: 7, pageUrl: 'https://example.test/page', links: 1000 }]);
  });
});
