import type { Handlers } from '../lib/bus/bus';
import { buildDiagnostics } from '../lib/log/diagnostics';
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
          state: {},
          settings: await services.settings.get(),
          log: await services.log.read(),
        }),
    },
    'pairing.view': { handle: () => services.pairing.view() },
    'pairing.start': { handle: () => services.pairing.start() },
    'pairing.poll': { handle: () => services.pairing.poll() },
    'pairing.cancel': { handle: () => services.pairing.cancel() },
    'log.clear': {
      handle: async () => {
        await services.log.clear();
        return null;
      },
    },
  };
}
