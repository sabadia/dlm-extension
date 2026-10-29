import { ApiError, NetworkError } from '../api/errors';
import type { Health } from '../api/client';
import type { Logger } from '../log/log';
import { checkCompatibility, type Compatibility } from '../native/compat';
import { LOCAL_TARGET, type RemoteTarget, type Settings } from '../settings/schema';
import type { SecretStore, SettingsStore } from '../settings/store';
import { withoutTarget, withRemoteTarget } from '../settings/store';
import { isLoopbackHost, normalizeBaseUrl, type UrlProblem } from '../settings/url';

/** A thing to tell the person before or after they add a server. */
export type RemoteWarning =
  /** `http://` to another computer: the token and the downloads' addresses travel unencrypted. */
  'plain-http';

/** What a connection test found. */
export type RemoteTestResult =
  | { ok: true; version: string; warnings: RemoteWarning[] }
  | { ok: false; problem: 'invalid-url'; detail: UrlProblem }
  | { ok: false; problem: 'unreachable'; message: string; https: boolean }
  | { ok: false; problem: 'unauthorized' }
  | { ok: false; problem: 'incompatible'; compatibility: Exclude<Compatibility, { ok: true }> }
  | { ok: false; problem: 'failed'; message: string };

/** Warnings for an address, without touching the network (the form shows them while the person types). */
export function warningsFor(baseUrl: string): RemoteWarning[] {
  const url = new URL(baseUrl);
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname) ? ['plain-http'] : [];
}

/** The part of the client the test needs. */
export interface RemoteProbe {
  health(): Promise<Health>;
  whoami(): Promise<{ scope: string }>;
}

export interface RemoteDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  client(baseUrl: string, token: string): RemoteProbe;
  log: Logger;
  /** Called after the set of targets or the active target changed, so the connection state follows. */
  changed?: () => void;
  newId?: () => string;
}

/** A target as the pages see it: no token, only whether there is one. */
export interface RemoteView {
  id: string;
  kind: 'local' | 'remote';
  name: string;
  url?: string;
  hasToken: boolean;
  active: boolean;
}

export type AddResult =
  { ok: true; id: string; warnings: RemoteWarning[] } | Exclude<RemoteTestResult, { ok: true }>;

/** Adding, testing, listing and removing the DLM servers the extension may send downloads to. */
export class RemoteService {
  constructor(private readonly deps: RemoteDeps) {}

  /** Calls the server (health, then whoami with the token) and reports what it found. Stores nothing. */
  async test(input: { url: string; token: string }): Promise<RemoteTestResult> {
    const normalized = normalizeBaseUrl(input.url);
    if (!normalized.ok) return { ok: false, problem: 'invalid-url', detail: normalized.problem };
    const client = this.deps.client(normalized.url, input.token.trim());
    try {
      const health = await client.health();
      const compatibility = checkCompatibility({
        version: health.version,
        apiVersion: health.apiVersion,
        minClientApi: health.minClientApi,
      });
      if (!compatibility.ok) return { ok: false, problem: 'incompatible', compatibility };
      await client.whoami();
      return { ok: true, version: health.version, warnings: warningsFor(normalized.url) };
    } catch (e) {
      if (e instanceof ApiError && e.unauthorized) return { ok: false, problem: 'unauthorized' };
      if (e instanceof NetworkError) {
        return {
          ok: false,
          problem: 'unreachable',
          message: e.message,
          https: normalized.url.startsWith('https:'),
        };
      }
      this.deps.log.warn('remote', 'test failed', { error: e });
      return { ok: false, problem: 'failed', message: e instanceof Error ? e.message : 'failed' };
    }
  }

  /** Tests the server and, when it answers and accepts the token, saves it (token apart from the settings). */
  async add(input: { name: string; url: string; token: string }): Promise<AddResult> {
    const result = await this.test(input);
    if (!result.ok) return result;
    const normalized = normalizeBaseUrl(input.url);
    if (!normalized.ok) return { ok: false, problem: 'invalid-url', detail: normalized.problem };
    const id = (this.deps.newId ?? (() => crypto.randomUUID()))();
    const target: RemoteTarget = {
      id,
      kind: 'remote',
      name: input.name.trim() || normalized.url,
      url: normalized.url,
    };
    await this.deps.secrets.set(id, input.token.trim());
    await this.deps.settings.update((s) => withRemoteTarget(s, target));
    this.deps.log.info('remote', 'added a server', { url: normalized.url });
    this.deps.changed?.();
    return { ok: true, id, warnings: result.warnings };
  }

  /** Replaces the token of a server (after it was revoked or rotated), once the server accepts it. */
  async replaceToken(id: string, token: string): Promise<RemoteTestResult> {
    const settings = await this.deps.settings.get();
    const target = settings.targets.find((t) => t.id === id);
    if (target?.kind !== 'remote')
      return { ok: false, problem: 'failed', message: 'Unknown server.' };
    const result = await this.test({ url: target.url, token });
    if (result.ok) {
      await this.deps.secrets.set(id, token.trim());
      this.deps.changed?.();
    }
    return result;
  }

  /** Forgets a server and its token. The local DLM cannot be removed. */
  async remove(id: string): Promise<void> {
    if (id === LOCAL_TARGET.id) return;
    await this.deps.settings.update((s) => withoutTarget(s, id));
    await this.deps.secrets.remove(id);
    this.deps.log.info('remote', 'removed a server');
    this.deps.changed?.();
  }

  /** Makes a server (or the local DLM) the one downloads go to. */
  async setActive(id: string): Promise<void> {
    await this.deps.settings.update((s) =>
      s.targets.some((t) => t.id === id) ? { ...s, activeTargetId: id } : s,
    );
    this.deps.changed?.();
  }

  async list(): Promise<RemoteView[]> {
    const settings: Settings = await this.deps.settings.get();
    return Promise.all(
      settings.targets.map(async (t) => ({
        id: t.id,
        kind: t.kind,
        name: t.kind === 'remote' ? t.name : 'DLM on this computer',
        ...(t.kind === 'remote' ? { url: t.url } : {}),
        hasToken: await this.deps.secrets.has(t.id),
        active: t.id === settings.activeTargetId,
      })),
    );
  }
}
