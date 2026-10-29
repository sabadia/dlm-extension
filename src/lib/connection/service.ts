import { DlmClient } from '../api/client';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import type { NativeHost } from '../native/host';
import type { PairingService } from '../pairing/service';
import type { SecretStore, SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { probe, resolveConnection, type ProbeClient, type ResolveDeps } from './resolve';
import { badgeFor, STATE_TEXT, type ConnectionState } from './state';

/** The toolbar button, as the browser offers it (`browser.action`). */
export interface ActionApi {
  setBadgeText(details: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
  setTitle(details: { title: string }): Promise<void> | void;
}

export interface ConnectionDeps {
  settings: Pick<SettingsStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  host: Pick<NativeHost, 'connect'>;
  pairing: Pick<PairingService, 'view'>;
  /** `storage.session`. */
  area: KeyValueArea;
  action: ActionApi;
  log: Logger;
  /** Whether the browser lets the extension call an address; defaults to yes (Chrome grants it at install). */
  hasAccess?: (baseUrl: string) => Promise<boolean>;
  /** Builds the client for an address; tests pass a fake. */
  client?: (baseUrl: string, token: string | undefined) => ProbeClient;
}

const CHECKING: ConnectionState = { kind: 'checking' };

function parseState(raw: unknown): ConnectionState {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { kind?: unknown }).kind === 'string'
  ) {
    return raw as ConnectionState;
  }
  return CHECKING;
}

/** The text of a state for a person (tooltip, popup). */
export function describeState(state: ConnectionState): string {
  const key = STATE_TEXT[state.kind];
  switch (state.kind) {
    case 'host-failed':
      return t(key, { message: state.message });
    case 'access-needed':
      return t(key, { origin: state.origin });
    case 'remote-unreachable':
      return t(key, { message: state.message });
    case 'connected':
      return t(key, { version: state.version });
    case 'incompatible':
      return state.compatibility.reason === 'daemon-too-old'
        ? t('state.daemonTooOld', { minVersion: state.compatibility.minVersion })
        : t('state.extensionTooOld');
    default:
      return t(key);
  }
}

/**
 * Keeps the connection state of the active target: `refresh` works it out and stores it (so a popup that opens later
 * reads it at once, and a restarted worker still has it), and the toolbar badge and tooltip follow.
 */
export class ConnectionService {
  private readonly stored: StoredValue<ConnectionState>;
  private running: Promise<ConnectionState> | undefined;

  constructor(private readonly deps: ConnectionDeps) {
    this.stored = new StoredValue(deps.area, 'connection', parseState);
  }

  get(): Promise<ConnectionState> {
    return this.stored.get();
  }

  /** Looks again. Calls made while a check runs share its result. */
  refresh(): Promise<ConnectionState> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async check(): Promise<ConnectionState> {
    const { deps } = this;
    let state: ConnectionState;
    let badgeEnabled = true;
    try {
      const settings = await deps.settings.get();
      badgeEnabled = settings.preferences.badge;
      const target =
        settings.targets.find((x) => x.id === settings.activeTargetId) ?? settings.targets[0];
      if (!target) throw new Error('no target');
      const host = deps.host;
      const resolveDeps: ResolveDeps = {
        target,
        token: await deps.secrets.get(target.id),
        discover: () => host.connect(),
        pairing: () => deps.pairing.view(),
        hasAccess: deps.hasAccess ?? (() => Promise.resolve(true)),
        client:
          deps.client ??
          ((baseUrl, token) =>
            new DlmClient({ baseUrl, ...(token !== undefined ? { token } : {}), log: deps.log })),
      };
      state = CHECKING;
      // Cheap path: the address that worked last time usually still works, and asking the host starts a process.
      const last = await this.stored.get();
      if (
        last.kind === 'connected' &&
        last.targetId === target.id &&
        resolveDeps.token !== undefined
      ) {
        state = await probe(resolveDeps, last.baseUrl, target.id);
      }
      if (state.kind !== 'connected') state = await resolveConnection(resolveDeps);
    } catch (e) {
      deps.log.error('connection', 'check failed', { error: e });
      state = { kind: 'host-failed', message: e instanceof Error ? e.message : 'check failed' };
    }
    const previous = await this.stored.get();
    await this.stored.set(state);
    if (previous.kind !== state.kind)
      deps.log.info('connection', `${previous.kind} -> ${state.kind}`);
    await this.paint(state, badgeEnabled);
    return state;
  }

  /** Puts the state on the toolbar button. Never throws: a missing action API must not break the check. */
  private async paint(state: ConnectionState, badgeEnabled: boolean): Promise<void> {
    const badge = badgeFor(state, badgeEnabled);
    try {
      await this.deps.action.setBadgeText({ text: badge.text });
      await this.deps.action.setBadgeBackgroundColor({ color: badge.color });
      await this.deps.action.setTitle({ title: `DLM: ${describeState(state)}` });
    } catch (e) {
      this.deps.log.warn('connection', 'could not update the toolbar button', { error: e });
    }
  }
}
