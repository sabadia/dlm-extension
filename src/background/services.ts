import { RingLog } from '../lib/log/log';
import { SecretStore, SettingsStore } from '../lib/settings/store';
import type { KeyValueArea } from '../lib/storage/area';

/** What the background needs from the browser, so that it can be built and tested without one. */
export interface Environment {
  /** `storage.local`: settings and tokens. Never `sync`. */
  local: KeyValueArea;
  /** `storage.session`: the log and state that may be lost with the browser session. */
  session: KeyValueArea;
  /** The extension's version from the manifest. */
  version: string;
  userAgent: string;
}

/**
 * The background's collaborators. They hold no state of their own beyond what a restarted worker can read back from
 * storage, so building them again after a restart is harmless (and there are no module-level singletons).
 */
export interface Services {
  log: RingLog;
  settings: SettingsStore;
  secrets: SecretStore;
  version: string;
  userAgent: string;
}

export function createServices(env: Environment): Services {
  return {
    log: new RingLog(env.session),
    settings: new SettingsStore(env.local),
    secrets: new SecretStore(env.local),
    version: env.version,
    userAgent: env.userAgent,
  };
}
