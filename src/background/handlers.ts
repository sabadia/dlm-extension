import type { Handlers, SenderLike } from '../lib/bus/bus';
import { buildDiagnostics } from '../lib/log/diagnostics';
import { describeState } from '../lib/connection/service';
import type { AskChoice } from '../lib/intercept/service';
import type { Services } from './services';

function tabIdOf(sender: SenderLike): number | undefined {
  const tab = sender.tab;
  if (typeof tab !== 'object' || tab === null || !('id' in tab)) return undefined;
  return typeof tab.id === 'number' ? tab.id : undefined;
}

const ASK_CHOICES: readonly AskChoice[] = ['dlm', 'browser', 'always'];

/** The answers the background gives to its pages (docs: `src/lib/bus/messages.ts` lists the messages). */
export function createHandlers(services: Services): Handlers {
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
  };
}
