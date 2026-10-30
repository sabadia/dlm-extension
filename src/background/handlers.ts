import { isTopFrame, type Handlers, type SenderLike } from '../lib/bus/bus';
import { buildDiagnostics } from '../lib/log/diagnostics';
import { describeState } from '../lib/connection/service';
import type { AskChoice } from '../lib/intercept/service';
import { acceptedHints } from '../lib/page/hints';
import { t } from '../lib/i18n';
import { SettingsImportError } from '../lib/settings/store';
import { isDirectScheme } from '../lib/links/classify';
import { parseSnapshot } from '../lib/media/page';
import type { Services } from './services';

function tabIdOf(sender: SenderLike): number | undefined {
  const tab = sender.tab;
  if (typeof tab !== 'object' || tab === null || !('id' in tab)) return undefined;
  return typeof tab.id === 'number' ? tab.id : undefined;
}

/** A tab may hand over this many magnet links in this long. */
const ADD_LIMIT = 5;
const ADD_WINDOW_MS = 10_000;

const MAX_URL = 8192;

function originOfSender(sender: SenderLike): string | undefined {
  try {
    const { origin } = new URL(sender.url ?? '');
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
/** The most addresses one links-page send may carry. */
const MAX_SEND = 500;

/** An address the links page may send: a web address, or a magnet or eD2K link. */
function isSendable(url: string): boolean {
  if (isDirectScheme(url)) return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'ftp:';
  } catch {
    return false;
  }
}

const ASK_CHOICES: readonly AskChoice[] = ['dlm', 'browser', 'always', 'omit'];

/** The answers the background gives to its pages (docs: `src/lib/bus/messages.ts` lists the messages). */
export function createHandlers(services: Services): Handlers {
  // Magnet links a tab handed over lately. Only a real click can make one (the content script checks), so this is a
  // second wall against a page that finds a way; losing it with the worker costs nothing.
  const recentAdds = new Map<number, number[]>();
  const allowAdd = (tabId: number): boolean => {
    const now = Date.now();
    const recent = (recentAdds.get(tabId) ?? []).filter((at) => now - at < ADD_WINDOW_MS);
    if (recent.length >= ADD_LIMIT) {
      recentAdds.set(tabId, recent);
      return false;
    }
    recentAdds.set(tabId, [...recent, now]);
    return true;
  };
  return {
    'ext.info': { handle: () => ({ version: services.version }) },
    'diagnostics.get': {
      handle: async () =>
        buildDiagnostics({
          version: services.version,
          userAgent: services.userAgent,
          state: await services.connection.get(),
          settings: await services.settings.get(),
          log: await services.log.read(),
        }),
    },
    'connection.get': {
      handle: async () => {
        const state = await services.connection.get();
        return { state, text: describeState(state) };
      },
    },
    'connection.refresh': {
      handle: async () => {
        const state = await services.connection.refresh();
        return { state, text: describeState(state) };
      },
    },
    'pairing.view': { handle: () => services.pairing.view() },
    'pairing.start': { handle: () => services.pairing.start() },
    'pairing.poll': {
      handle: async () => {
        const view = await services.pairing.poll();
        // A new token changes the connection state; do not wait for the next scheduled check.
        if (view.phase === 'approved') void services.connection.refresh();
        return view;
      },
    },
    'pairing.cancel': { handle: () => services.pairing.cancel() },
    'remote.list': { handle: () => services.remote.list() },
    'remote.test': { handle: (input) => services.remote.test(input) },
    'remote.add': { handle: (input) => services.remote.add(input) },
    'remote.replaceToken': { handle: ({ id, token }) => services.remote.replaceToken(id, token) },
    'remote.remove': {
      handle: async ({ id }) => {
        await services.remote.remove(id);
        return null;
      },
    },
    'remote.setActive': {
      handle: async ({ id }) => {
        await services.remote.setActive(id);
        return null;
      },
    },
    'log.clear': {
      handle: async () => {
        await services.log.clear();
        return null;
      },
    },
    'gesture.note': {
      fromContent: true,
      handle: (input, sender) => {
        const tabId = tabIdOf(sender);
        if (
          tabId === undefined ||
          typeof input.alt !== 'boolean' ||
          typeof input.shift !== 'boolean'
        )
          return null;
        return (
          services.intercept?.noteGesture(tabId, input.alt, input.shift).then(() => null) ?? null
        );
      },
    },
    'ask.get': {
      handle: ({ id }) => services.intercept?.askView(id) ?? Promise.resolve(null),
    },
    'ask.choose': {
      handle: async ({ id, choice }) => {
        if (!ASK_CHOICES.includes(choice)) return null;
        await services.intercept?.choose(id, choice);
        return null;
      },
    },
    'page.hints': {
      fromContent: true,
      handle: async (input, sender) => {
        if (!isTopFrame(sender)) return null;
        // The page the hints came from is the sender's, never what the content script says.
        const origin = originOfSender(sender);
        if (origin === undefined) return null;
        await services.intercept?.noteHints(acceptedHints(input?.hints), origin);
        return null;
      },
    },
    'links.add': {
      fromContent: true,
      handle: async (input, sender) => {
        // Only a magnet or eD2K link, only from the top frame of a tab; anything else is not ours to send.
        if (!isTopFrame(sender)) return false;
        if (typeof input?.url !== 'string' || input.url.length > MAX_URL) return false;
        if (!isDirectScheme(input.url)) return false;
        const tabId = tabIdOf(sender);
        if (tabId === undefined || !allowAdd(tabId)) return false;
        return (await services.links?.addDirect(input.url)) ?? false;
      },
    },
    'links.send': {
      handle: async (input) => {
        const urls = Array.isArray(input?.urls)
          ? input.urls
              .filter(
                (url): url is string =>
                  typeof url === 'string' && url.length < MAX_URL && isSendable(url),
              )
              .slice(0, MAX_SEND)
          : [];
        return (await services.links?.sendMany(urls)) ?? { ok: 0, failed: urls.length };
      },
    },
    'media.list': {
      handle: ({ tabId }) =>
        services.media?.forTab(tabId) ??
        Promise.resolve({
          items: [],
          title: '',
          protectedMedia: false,
          blobOrMse: false,
          pageUrl: '',
        }),
    },
    'media.scan': {
      fromContent: true,
      handle: (input, sender) => {
        const tabId = tabIdOf(sender);
        if (tabId === undefined || !isTopFrame(sender) || sender.url === undefined) return null;
        // The address of the page is the sender's, not the one the content script claims.
        const snapshot = parseSnapshot(input?.snapshot, sender.url);
        if (!snapshot) return null;
        return services.media?.scan(tabId, snapshot).then(() => null) ?? null;
      },
    },
    'media.protected': {
      fromContent: true,
      handle: (_input, sender) => {
        const tabId = tabIdOf(sender);
        if (tabId === undefined) return null;
        return services.media?.markProtected(tabId).then(() => null) ?? null;
      },
    },
    'media.download': {
      handle: (input) =>
        services.media?.download(input) ??
        Promise.resolve({ ok: false, error: t('error.noMedia') }),
    },
    'media.variants': {
      handle: ({ url }) => services.media?.variants(url) ?? Promise.resolve([]),
    },
    'media.probe': {
      handle: ({ urls }) =>
        services.media?.probe(urls.filter((url) => typeof url === 'string')) ?? Promise.resolve([]),
    },
    'settings.get': { handle: () => services.settings.get() },
    'settings.save': {
      handle: async (patch) => {
        const saved = await services.settings.save(patch);
        await services.applySurface?.(saved.files.surface);
        return saved;
      },
    },
    'settings.export': { handle: () => services.settings.export() },
    'settings.import': {
      handle: async ({ text }) => {
        const settings = await services.settings.import(text).catch((error: unknown) => {
          // The page gets the sentence, not the reason code.
          throw error instanceof SettingsImportError
            ? new Error(t(`options.importError.${error.reason}`))
            : error;
        });
        // A server that is not in the file, or has a new address, must not keep the token it had.
        await services.secrets.keepOnly(settings.targets.map((target) => target.id));
        await services.applySurface?.(settings.files.surface);
        return settings;
      },
    },
    'downloads.test': {
      handle: async () => {
        try {
          await services.downloads.test();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : t('error.failed') };
        }
      },
    },
  };
}
