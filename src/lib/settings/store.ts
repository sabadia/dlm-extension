import type { KeyValueArea } from '../storage/area';
import { adoptImported } from './import';
import { migrateSettings, SettingsTooNewError } from './migrate';
import { parseSettings } from './parse';
import {
  defaultSettings,
  LOCAL_TARGET,
  type RemoteTarget,
  type Settings,
  type SettingsPatch,
} from './schema';

export const SETTINGS_KEY = 'settings';
export const SECRETS_KEY = 'secrets';

/**
 * Reads and writes the settings. Updates are applied one after another, each on the value the previous one left, so
 * two parts of the extension changing different fields at the same time cannot lose each other's change.
 */
export class SettingsStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: KeyValueArea) {}

  /** The settings. Damaged data reads as the defaults; settings from a newer version throw `SettingsTooNewError`. */
  async get(): Promise<Settings> {
    const stored = await this.area.get(SETTINGS_KEY);
    if (stored === undefined) return defaultSettings();
    return parseSettings(migrateSettings(stored));
  }

  /** Applies `change` to the current settings and saves the result (after parsing it again, so it is always valid). */
  update(change: (current: Settings) => Settings): Promise<Settings> {
    const run = async (): Promise<Settings> => {
      const next = parseSettings(change(await this.get()));
      await this.area.set(SETTINGS_KEY, next);
      return next;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /**
   * Saves what the options page edited (rules, preferences, routes) on top of the current settings, so a server added
   * or a target chosen meanwhile is not undone by a form that was loaded earlier.
   */
  save(patch: SettingsPatch): Promise<Settings> {
    return this.update((current) => ({
      ...current,
      rules: patch.rules,
      preferences: patch.preferences,
      routes: patch.routes,
    }));
  }

  /** Settings as a file a person can keep: no tokens (they are not in the settings), pretty-printed. */
  async export(): Promise<string> {
    return JSON.stringify(await this.get(), null, 2);
  }

  /**
   * Replaces the settings with those of an exported file. The file is migrated and validated; nothing is stored when it
   * is not JSON or comes from a newer version. Tokens are not in the file, and a server whose address differs from the
   * one already known gets a new id and no token (see {@link adoptImported}); the caller removes the tokens of servers
   * that are gone (`SecretStore.keepOnly`).
   */
  async import(text: string, newId: () => string = () => crypto.randomUUID()): Promise<Settings> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SettingsImportError('not-json');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new SettingsImportError('not-settings');
    let migrated: unknown;
    try {
      migrated = migrateSettings(raw);
    } catch (e) {
      throw new SettingsImportError(e instanceof SettingsTooNewError ? 'too-new' : 'not-settings');
    }
    const incoming = parseSettings(migrated);
    return this.update((current) => adoptImported(current, incoming, newId));
  }
}

export class SettingsImportError extends Error {
  constructor(readonly reason: 'not-json' | 'not-settings' | 'too-new') {
    super(`The settings file could not be imported (${reason}).`);
    this.name = 'SettingsImportError';
  }
}

/** The tokens, by target id. Kept apart from the settings so that nothing exports or prints them by accident. */
export class SecretStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: KeyValueArea) {}

  private async read(): Promise<Record<string, string>> {
    const raw = await this.area.get(SECRETS_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }

  async get(targetId: string): Promise<string | undefined> {
    return (await this.read())[targetId];
  }

  async has(targetId: string): Promise<boolean> {
    return (await this.get(targetId)) !== undefined;
  }

  set(targetId: string, token: string): Promise<void> {
    return this.change((all) => ({ ...all, [targetId]: token }));
  }

  /** Removes every token that is not for one of `ids`. */
  keepOnly(ids: readonly string[]): Promise<void> {
    return this.change((all) =>
      Object.fromEntries(Object.entries(all).filter(([id]) => ids.includes(id))),
    );
  }

  remove(targetId: string): Promise<void> {
    return this.change((all) =>
      Object.fromEntries(Object.entries(all).filter(([id]) => id !== targetId)),
    );
  }

  private change(fn: (all: Record<string, string>) => Record<string, string>): Promise<void> {
    const run = async (): Promise<void> => {
      await this.area.set(SECRETS_KEY, fn(await this.read()));
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}

/** Adds or replaces a remote target. */
export function withRemoteTarget(settings: Settings, target: RemoteTarget): Settings {
  const others = settings.targets.filter((t) => t.id !== target.id);
  return { ...settings, targets: [...others, target] };
}

/** Removes a remote target; the active target falls back to the local one when it was the removed one. */
export function withoutTarget(settings: Settings, id: string): Settings {
  if (id === LOCAL_TARGET.id) return settings;
  return {
    ...settings,
    targets: settings.targets.filter((t) => t.id !== id),
    routes: settings.routes.filter((route) => route.targetId !== id),
    activeTargetId: settings.activeTargetId === id ? LOCAL_TARGET.id : settings.activeTargetId,
  };
}
