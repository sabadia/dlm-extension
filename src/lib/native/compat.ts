/** The oldest `dlm` (daemon) release this extension works with: the first with pairing and the extension token scope. */
export const MIN_DAEMON_VERSION = '0.6.0';

/** The REST API version this extension was written for; the daemon's `minClientApi` must not be above it. */
export const EXTENSION_API_VERSION = 1;

/** The oldest REST API version this extension can talk to. */
export const MIN_API_VERSION = 1;

/** `1.2.3` or `v1.2.3-rc.1` as numbers; undefined for anything else (a development build, an empty string). */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `version` is at least `minimum`. A version that cannot be read counts as new enough (development builds). */
export function atLeast(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: 'daemon-too-old'; minVersion: string }
  | { ok: false; reason: 'extension-too-old'; requiredApi: number };

/**
 * Whether this extension can work with a daemon, from what the native host reports (`version`, `apiVersion`) and,
 * once connected, what `/v1/health` says (`minClientApi`).
 */
export function checkCompatibility(info: {
  version?: string | undefined;
  apiVersion?: number | undefined;
  minClientApi?: number | undefined;
}): Compatibility {
  const tooOld: Compatibility = {
    ok: false,
    reason: 'daemon-too-old',
    minVersion: MIN_DAEMON_VERSION,
  };
  if (info.apiVersion !== undefined && info.apiVersion < MIN_API_VERSION) return tooOld;
  if (info.version !== undefined && !atLeast(info.version, MIN_DAEMON_VERSION)) return tooOld;
  if (info.minClientApi !== undefined && info.minClientApi > EXTENSION_API_VERSION) {
    return { ok: false, reason: 'extension-too-old', requiredApi: info.minClientApi };
  }
  return { ok: true };
}
