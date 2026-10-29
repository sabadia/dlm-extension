import {
  DEFAULT_MIN_SIZE_BYTES,
  defaultSettings,
  LOCAL_TARGET,
  SETTINGS_VERSION,
  type Preferences,
  type RemoteTarget,
  type Rules,
  type Settings,
  type Target,
} from './schema';
import { normalizeBaseUrl } from './url';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Normalises a host name typed for an exclusion: lower case, no scheme, no path, no leading `*.` or dot. */
export function normalizeSite(input: string): string | undefined {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^\*?\./, '')
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, '');
  return text && /^[a-z0-9.-]+$/.test(text) ? text : undefined;
}

function parseRules(raw: unknown): Rules {
  const d = defaultSettings().rules;
  if (!isObj(raw)) return d;
  const size = raw.minSizeBytes;
  const bypass = raw.bypassKey;
  const sites = Array.isArray(raw.excludedSites) ? raw.excludedSites : [];
  return {
    intercept: bool(raw.intercept, d.intercept),
    minSizeBytes:
      typeof size === 'number' && Number.isFinite(size) && size >= 0
        ? Math.floor(size)
        : DEFAULT_MIN_SIZE_BYTES,
    excludedSites: [
      ...new Set(
        sites
          .flatMap((s) => (typeof s === 'string' ? [normalizeSite(s)] : []))
          .filter((s): s is string => s !== undefined),
      ),
    ],
    bypassKey: bypass === 'alt' || bypass === 'shift' || bypass === 'none' ? bypass : d.bypassKey,
    askFirst: bool(raw.askFirst, d.askFirst),
    privateWindows: bool(raw.privateWindows, d.privateWindows),
  };
}

function parsePreferences(raw: unknown): Preferences {
  const d = defaultSettings().preferences;
  if (!isObj(raw)) return d;
  return {
    badge: bool(raw.badge, d.badge),
    notifications: bool(raw.notifications, d.notifications),
  };
}

function parseTargets(raw: unknown): Target[] {
  const out: Target[] = [{ ...LOCAL_TARGET }];
  const seen = new Set<string>([LOCAL_TARGET.id]);
  for (const t of Array.isArray(raw) ? raw : []) {
    if (!isObj(t) || t.kind !== 'remote') continue;
    const { id, name, url } = t;
    if (
      typeof id !== 'string' ||
      id === '' ||
      seen.has(id) ||
      typeof name !== 'string' ||
      typeof url !== 'string'
    )
      continue;
    const normalized = normalizeBaseUrl(url);
    if (!normalized.ok) continue;
    seen.add(id);
    const target: RemoteTarget = {
      id,
      kind: 'remote',
      name: name.trim() || normalized.url,
      url: normalized.url,
    };
    out.push(target);
  }
  return out;
}

/**
 * Reads settings of the current version from untrusted data (storage, an imported file). It never throws: what is
 * missing or wrong falls back to the default, so a damaged file cannot stop the extension. The local target is always
 * present; remote targets with a bad address are dropped.
 */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const targets = parseTargets(raw.targets);
  const wanted = typeof raw.activeTargetId === 'string' ? raw.activeTargetId : undefined;
  const active = wanted !== undefined && targets.some((t) => t.id === wanted);
  return {
    version: SETTINGS_VERSION,
    activeTargetId: active && wanted !== undefined ? wanted : d.activeTargetId,
    targets,
    rules: parseRules(raw.rules),
    preferences: parsePreferences(raw.preferences),
  };
}
