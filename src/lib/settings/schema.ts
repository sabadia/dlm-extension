/**
 * The settings of the extension. They live in `storage.local` and are never synced (docs/CONVENTIONS.md). Secrets (the
 * tokens of the targets) are not part of them: they have a store of their own, so that export, diagnostics and the log
 * cannot carry them by accident.
 */

/** The version of the stored shape. Raise it together with a migration in `migrate.ts`. */
export const SETTINGS_VERSION = 1;

/** The DLM on this computer, found through the native host. There is exactly one. */
export interface LocalTarget {
  id: 'local';
  kind: 'local';
}

/** A DLM server somewhere else, reached by URL and token. */
export interface RemoteTarget {
  id: string;
  kind: 'remote';
  name: string;
  /** Origin and optional path prefix, no trailing slash: `https://dlm.example.test`. */
  url: string;
}

export type Target = LocalTarget | RemoteTarget;

export type BypassKey = 'alt' | 'shift' | 'none';

/** When downloads are taken over (used from E2 on). */
export interface Rules {
  /** Take over browser downloads at all. */
  intercept: boolean;
  /** Files smaller than this stay in the browser. */
  minSizeBytes: number;
  /** Sites (host names, with their subdomains) that are never taken over. */
  excludedSites: string[];
  /** Holding this key while starting a download keeps it in the browser. */
  bypassKey: BypassKey;
  /** Ask before sending, instead of sending at once. */
  askFirst: boolean;
  /** Take over downloads of private windows (off unless the user allows it). */
  privateWindows: boolean;
}

export interface Preferences {
  /** Show the state and the number of downloads on the toolbar button. */
  badge: boolean;
  /** Notify about things that need the user (an expired link, a lost connection). */
  notifications: boolean;
}

export interface Settings {
  version: typeof SETTINGS_VERSION;
  /** The target downloads go to when no site rule says otherwise. */
  activeTargetId: string;
  targets: Target[];
  rules: Rules;
  preferences: Preferences;
}

export const LOCAL_TARGET: LocalTarget = { id: 'local', kind: 'local' };

/** 1 MB: smaller files stay in the browser (docs/PLAN.md, decisions). */
export const DEFAULT_MIN_SIZE_BYTES = 1_000_000;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    activeTargetId: LOCAL_TARGET.id,
    targets: [{ ...LOCAL_TARGET }],
    rules: {
      intercept: true,
      minSizeBytes: DEFAULT_MIN_SIZE_BYTES,
      excludedSites: [],
      bypassKey: 'alt',
      askFirst: false,
      privateWindows: false,
    },
    preferences: { badge: true, notifications: true },
  };
}
