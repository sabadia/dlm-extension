import { normalizeFileType, normalizeMimeType, normalizeSite } from './parse';
import type { BypassKey, Settings, SettingsSave } from './schema';

/**
 * What the options form holds while it is edited: the raw text of every field. Text is parsed when the person saves,
 * never on each keystroke: a list field that rebuilt itself from parsed values would swallow the Enter or the comma that
 * the person has just typed.
 */
export interface FormDraft {
  intercept: boolean;
  /** Bytes, as typed. */
  minSize: string;
  excludedSites: string;
  alwaysSites: string;
  fileTypes: string;
  mimeTypes: string;
  bypassKey: BypassKey;
  askFirst: boolean;
  privateWindows: boolean;
  badge: boolean;
  notifications: boolean;
  mirrors: boolean;
  refresh: boolean;
  routes: { site: string; targetId: string }[];
  files: Settings['files'];
}

export type FormField =
  'minSize' | 'excludedSites' | 'alwaysSites' | 'fileTypes' | 'mimeTypes' | 'routes';

/** What is wrong with a field: the entries that were refused, or `[]` for a field with one value. */
export type FormErrors = Partial<Record<FormField, string[]>>;

export function draftFrom(settings: Settings): FormDraft {
  const { rules, preferences } = settings;
  return {
    intercept: rules.intercept,
    minSize: String(rules.minSizeBytes),
    excludedSites: rules.excludedSites.join('\n'),
    alwaysSites: rules.alwaysSites.join('\n'),
    fileTypes: rules.fileTypes.join(', '),
    mimeTypes: rules.mimeTypes.join(', '),
    bypassKey: rules.bypassKey,
    askFirst: rules.askFirst,
    privateWindows: rules.privateWindows,
    badge: preferences.badge,
    notifications: preferences.notifications,
    mirrors: preferences.mirrors,
    refresh: preferences.refresh,
    routes: settings.routes.map((route) => ({ ...route })),
    files: { ...settings.files },
  };
}

/** Entries of a list field: one per line or separated by commas; empty ones are skipped. */
export function entries(text: string): string[] {
  return text
    .split(/[\n\r,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function normalizeAll(
  text: string,
  normalize: (input: string) => string | undefined,
): { values: string[]; rejected: string[] } {
  const values: string[] = [];
  const rejected: string[] = [];
  for (const entry of entries(text)) {
    const value = normalize(entry);
    if (value === undefined) rejected.push(entry);
    else if (!values.includes(value)) values.push(value);
  }
  return { values, rejected };
}

/**
 * The settings the draft stands for, or what is wrong with it. Nothing is saved with a field that has a refused
 * entry: the person is told which, instead of the entry being dropped without a word.
 */
export function settingsFrom(
  draft: FormDraft,
  current: Settings,
  targetIds: readonly string[],
): { ok: true; patch: SettingsSave } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const size = draft.minSize.trim();
  if (!/^\d{1,15}$/.test(size)) errors.minSize = [draft.minSize];
  const excluded = normalizeAll(draft.excludedSites, normalizeSite);
  const always = normalizeAll(draft.alwaysSites, normalizeSite);
  const types = normalizeAll(draft.fileTypes, normalizeFileType);
  const mimes = normalizeAll(draft.mimeTypes, normalizeMimeType);
  if (excluded.rejected.length > 0) errors.excludedSites = excluded.rejected;
  if (always.rejected.length > 0) errors.alwaysSites = always.rejected;
  if (types.rejected.length > 0) errors.fileTypes = types.rejected;
  if (mimes.rejected.length > 0) errors.mimeTypes = mimes.rejected;
  const routes: { site: string; targetId: string }[] = [];
  const badRoutes: string[] = [];
  for (const row of draft.routes) {
    if (row.site.trim() === '') continue;
    const site = normalizeSite(row.site);
    if (site === undefined || !targetIds.includes(row.targetId)) {
      badRoutes.push(row.site.trim());
      continue;
    }
    if (!routes.some((route) => route.site === site)) routes.push({ site, targetId: row.targetId });
  }
  if (badRoutes.length > 0) errors.routes = badRoutes;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    patch: {
      rules: {
        ...current.rules,
        intercept: draft.intercept,
        minSizeBytes: Number(size),
        excludedSites: excluded.values,
        alwaysSites: always.values,
        fileTypes: types.values,
        mimeTypes: mimes.values,
        bypassKey: draft.bypassKey,
        askFirst: draft.askFirst,
        privateWindows: draft.privateWindows,
      },
      preferences: {
        ...current.preferences,
        badge: draft.badge,
        notifications: draft.notifications,
        mirrors: draft.mirrors,
        refresh: draft.refresh,
      },
      routes,
      files: { ...current.files, ...draft.files },
      base: {
        rules: current.rules,
        preferences: current.preferences,
        routes: current.routes,
        files: current.files,
      },
    },
  };
}
