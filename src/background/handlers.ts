import type { Handlers } from '../lib/bus/bus';
import { buildDiagnostics } from '../lib/log/diagnostics';
import { describeState } from '../lib/connection/service';
import type { Services } from './services';

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
    'log.clear': {
      handle: async () => {
        await services.log.clear();
        return null;
      },
    },
  };
}
