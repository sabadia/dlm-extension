import { DlmClient } from '../api/client';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import type { NativeHost } from '../native/host';
import type { PairingService } from '../pairing/service';
import type { SecretStore, SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { HANDOFF_COUNT_KEY, parseHandoffCount } from '../intercept/count';
import { MEDIA_TABS_KEY, tabCounts } from '../media/store';
import { probe, resolveConnection, type ProbeClient, type ResolveDeps } from './resolve';
import { badgeFor, STATE_TEXT, type ConnectionState } from './state';

/** The toolbar button, as the browser offers it (`browser.action`). */
export interface ActionApi {
  setBadgeText(details: { text: string; tabId?: number }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void> | void;
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

  /**
   * The address and token of one target, when this extension can call it. A remote target uses its saved address.
   * The local target uses the address from the last successful check, or asks the native host.
   */
  async endpoint(targetId: string): Promise<{ baseUrl: string; token: string } | undefined> {
    const settings = await this.deps.settings.get();
    const target = settings.targets.find((item) => item.id === targetId);
    if (!target) return undefined;
    const token = await this.deps.secrets.get(target.id);
    if (!token) return undefined;
    if (target.kind === 'remote') return { baseUrl: target.url, token };
    const state = await this.get();
    if (state.kind === 'connected' && state.targetId === target.id) {
      return { baseUrl: state.baseUrl, token };
    }
    try {
      const found = await this.deps.host.connect();
      if (found.state === 'found') return { baseUrl: found.baseUrl, token };
    } catch (error) {
      this.deps.log.debug('connection', 'local target could not be reached', { error });
    }
    return undefined;
  }

  /** Every target that currently has an address and a token. */
  async endpoints(): Promise<{ baseUrl: string; token: string }[]> {
    const settings = await this.deps.settings.get();
    const out: { baseUrl: string; token: string }[] = [];
    for (const target of settings.targets) {
      const endpoint = await this.endpoint(target.id);
      if (endpoint) out.push(endpoint);
    }
    return out;
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

  /** Paints the toolbar button again without looking at the daemon (the hand-off count changed). */
  async repaint(): Promise<void> {
    const settings = await this.deps.settings.get().catch(() => undefined);
    await this.paint(await this.get(), settings?.preferences.badge ?? true);
  }

  /** Puts the state on the toolbar button: the default for every tab, and the media count of each tab that has any. */
  private async paint(state: ConnectionState, badgeEnabled: boolean): Promise<void> {
    const handoffs = parseHandoffCount(await this.deps.area.get(HANDOFF_COUNT_KEY));
    const badge = badgeFor(state, badgeEnabled, handoffs);
    try {
      await this.deps.action.setBadgeText({ text: badge.text });
      await this.deps.action.setBadgeBackgroundColor({ color: badge.color });
      await this.deps.action.setTitle({ title: `DLM: ${describeState(state)}` });
    } catch (e) {
      this.deps.log.warn('connection', 'could not update the toolbar button', { error: e });
    }
    // A tab with media shows its own count; the others keep the default. The counts are in storage, so a state
    // change repaints every tab that has one.
    const counts = tabCounts(await this.deps.area.get(MEDIA_TABS_KEY));
    for (const [tabId, count] of counts)
      await this.paintTabWith(tabId, count, state, badgeEnabled, handoffs);
  }

  /** The toolbar button of one tab: its media count, or the default when it has none. */
  async paintTab(tabId: number, count: number): Promise<void> {
    const settings = await this.deps.settings.get().catch(() => undefined);
    const handoffs = parseHandoffCount(await this.deps.area.get(HANDOFF_COUNT_KEY));
    await this.paintTabWith(
      tabId,
      count,
      await this.get(),
      settings?.preferences.badge ?? true,
      handoffs,
    );
  }

  private async paintTabWith(
    tabId: number,
    count: number,
    state: ConnectionState,
    badgeEnabled: boolean,
    handoffs: number,
  ): Promise<void> {
    const badge = badgeFor(state, badgeEnabled, count > 0 ? count : handoffs);
    try {
      await this.deps.action.setBadgeText({ text: badge.text, tabId });
      await this.deps.action.setBadgeBackgroundColor({ color: badge.color, tabId });
    } catch {
      // The tab is gone, or the browser has no per-tab badge: the default stays.
    }
  }
}
