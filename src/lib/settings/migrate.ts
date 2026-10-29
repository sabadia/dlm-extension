import { SETTINGS_VERSION } from './schema';

/** A step from stored version `n` to `n + 1`. It gets untrusted data and returns the next shape (still untrusted). */
export type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/**
 * The steps, keyed by the version they start from. Version 1 is the first shape, so there are none yet. A change to
 * the shape of the settings adds `1: (old) => …` here, raises `SETTINGS_VERSION`, and adds a test with a stored v1 file.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export class SettingsTooNewError extends Error {
  constructor(readonly found: number) {
    super(`The settings were saved by a newer version of the extension (${found}).`);
    this.name = 'SettingsTooNewError';
  }
}

/**
 * Brings stored settings to `current`. Data without a version counts as version 1 (written before versions existed
 * cannot happen, but an imported file may lack it). Data from a newer version is refused so that a downgrade does not
 * silently discard it.
 */
export function migrateSettings(
  raw: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  current: number = SETTINGS_VERSION,
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  let data = raw as Record<string, unknown>;
  let version =
    typeof data.version === 'number' && Number.isInteger(data.version) && data.version >= 1
      ? data.version
      : 1;
  if (version > current) throw new SettingsTooNewError(version);
  while (version < current) {
    const step = migrations[version];
    if (!step) throw new Error(`No migration from settings version ${version}.`);
    data = { ...step(data), version: version + 1 };
    version += 1;
  }
  return data;
}
