import {
  DEFAULT_MIN_SIZE_BYTES,
  defaultSettings,
  LOCAL_TARGET,
  SETTINGS_VERSION,
  type DomainRoute,
  type FilesPrefs,
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

/** An extension typed in the rules: lower case, no leading dot or `*.`. */
export function normalizeFileType(input: string): string | undefined {
  const text = input.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  return /^[a-z0-9]+$/.test(text) ? text : undefined;
}

/** A MIME type or a group (`video/`). Parameters (`text/plain; charset=utf-8`) are dropped. */
export function normalizeMimeType(input: string): string | undefined {
  const text = input.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (/^[a-z0-9!#$&^_.+-]+\/$/.test(text)) return text;
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(text) ? text : undefined;
}

/**
 * Normalises a host name typed for a site rule: lower case, no scheme, port, path, trailing dot, leading `*.` or dot,
 * and a name with non-ASCII letters in its punycode form (the one a request has). A bare name such as `com` is refused,
 * because a rule for it would cover a whole top-level domain; `localhost` and addresses are fine.
 */
export function normalizeSite(input: string): string | undefined {
  const typed = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^\*?\./, '')
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!typed) return undefined;
  let host: string;
  try {
    host = new URL(`http://${typed}`).hostname.replace(/\.$/, '');
  } catch {
    return undefined;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
  return host.includes('.') || host === 'localhost' ? host : undefined;
}

function siteList(raw: unknown): string[] {
  const sites = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      sites
        .flatMap((s) => (typeof s === 'string' ? [normalizeSite(s)] : []))
        .filter((s): s is string => s !== undefined),
    ),
  ];
}

function tokenList(raw: unknown, normalize: (input: string) => string | undefined): string[] {
  const items = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      items
        .flatMap((s) => (typeof s === 'string' ? [normalize(s)] : []))
        .filter((s): s is string => s !== undefined),
    ),
  ];
}

function parseRules(raw: unknown): Rules {
  const d = defaultSettings().rules;
  if (!isObj(raw)) return d;
  const size = raw.minSizeBytes;
  const bypass = raw.bypassKey;
  return {
    intercept: bool(raw.intercept, d.intercept),
    minSizeBytes:
      typeof size === 'number' && Number.isFinite(size) && size >= 0
        ? Math.floor(size)
        : DEFAULT_MIN_SIZE_BYTES,
    excludedSites: siteList(raw.excludedSites),
    alwaysSites: siteList(raw.alwaysSites),
    fileTypes: tokenList(raw.fileTypes, normalizeFileType),
    mimeTypes: tokenList(raw.mimeTypes, normalizeMimeType),
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
    mirrors: bool(raw.mirrors, d.mirrors),
    refresh: bool(raw.refresh, d.refresh),
  };
}

function parseFiles(raw: unknown): FilesPrefs {
  const d = defaultSettings().files;
  if (!isObj(raw)) return d;
  const sort = raw.sort;
  return {
    surface: raw.surface === 'popup' || raw.surface === 'panel' ? raw.surface : d.surface,
    naming: raw.naming === 'url' || raw.naming === 'title' ? raw.naming : d.naming,
    followRedirects: bool(raw.followRedirects, d.followRedirects),
    sort:
      sort === 'size-desc' || sort === 'size-asc' || sort === 'name' || sort === 'type'
        ? sort
        : d.sort,
  };
}

function parseRoutes(raw: unknown, targets: readonly Target[]): DomainRoute[] {
  const known = new Set(targets.map((target) => target.id));
  const out: DomainRoute[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObj(item) || typeof item.site !== 'string' || typeof item.targetId !== 'string')
      continue;
    const site = normalizeSite(item.site);
    if (!site || seen.has(site) || !known.has(item.targetId)) continue;
    seen.add(site);
    out.push({ site, targetId: item.targetId });
  }
  return out;
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
    routes: parseRoutes(raw.routes, targets),
    rules: parseRules(raw.rules),
    preferences: parsePreferences(raw.preferences),
    files: parseFiles(raw.files),
  };
}
