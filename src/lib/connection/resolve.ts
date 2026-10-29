import { ApiError, NetworkError } from '../api/errors';
import type { Health } from '../api/client';
import { checkCompatibility } from '../native/compat';
import type { Discovery } from '../native/host';
import type { PairingView } from '../pairing/service';
import { LOCAL_TARGET, type Target } from '../settings/schema';
import { originPattern } from '../settings/url';
import type { ConnectionState } from './state';

/** The part of the client the check needs. */
export interface ProbeClient {
  health(): Promise<Health>;
  whoami(): Promise<{ scope: string }>;
}

export interface ResolveDeps {
  target: Target;
  /** The token stored for the target, if any. */
  token: string | undefined;
  /** The native host (local target only). */
  discover(): Promise<Discovery>;
  pairing(): Promise<PairingView>;
  /** Whether the browser lets the extension call this address (Firefox asks first). */
  hasAccess(baseUrl: string): Promise<boolean>;
  /** A client for an address and token (the token may be absent for a first check). */
  client(baseUrl: string, token: string | undefined): ProbeClient;
}

/**
 * Works out the state of the connection to one target. It asks, in order: can DLM be found (local: the native host;
 * remote: the stored URL), does it speak a version this extension works with, is the stored token accepted. Every
 * failure is a state, none is thrown.
 */
export async function resolveConnection(deps: ResolveDeps): Promise<ConnectionState> {
  const { target } = deps;
  if (target.kind === 'remote') return resolveRemote(deps, target.url);

  const found = await deps.discover();
  switch (found.state) {
    case 'host-not-installed':
    case 'host-not-allowed':
      return { kind: found.state };
    case 'host-failed':
      return { kind: 'host-failed', message: found.message };
    case 'timeout':
      return { kind: 'host-failed', message: found.message };
    case 'app-not-running':
      return { kind: 'app-not-running' };
    case 'incompatible':
      return { kind: 'incompatible', compatibility: found.compatibility };
    case 'found':
      break;
  }

  if (!(await deps.hasAccess(found.baseUrl)))
    return { kind: 'access-needed', origin: originPattern(found.baseUrl) };
  if (deps.token === undefined) {
    return (await deps.pairing()).phase === 'pending'
      ? { kind: 'pairing' }
      : { kind: 'needs-pairing' };
  }
  const state = await probe(deps, found.baseUrl, LOCAL_TARGET.id);
  // The host says it runs, so a failure to connect is about the address, not about DLM being off.
  if (state.kind === 'remote-unreachable')
    return { kind: 'local-unreachable', https: found.baseUrl.startsWith('https:') };
  return state;
}

async function resolveRemote(deps: ResolveDeps, url: string): Promise<ConnectionState> {
  if (!(await deps.hasAccess(url))) return { kind: 'access-needed', origin: originPattern(url) };
  if (deps.token === undefined) return { kind: 'remote-needs-token', targetId: deps.target.id };
  return probe(deps, url, deps.target.id);
}

/** Health (version range) then whoami (token) against one address. */
export async function probe(
  deps: ResolveDeps,
  baseUrl: string,
  targetId: string,
): Promise<ConnectionState> {
  const client = deps.client(baseUrl, deps.token);
  try {
    const health = await client.health();
    const compatibility = checkCompatibility({
      version: health.version,
      apiVersion: health.apiVersion,
      minClientApi: health.minClientApi,
    });
    if (!compatibility.ok) return { kind: 'incompatible', compatibility };
    await client.whoami();
    return { kind: 'connected', targetId, baseUrl, version: health.version };
  } catch (e) {
    if (e instanceof ApiError && e.unauthorized) return { kind: 'token-revoked' };
    const message = e instanceof NetworkError || e instanceof Error ? e.message : 'failed';
    return { kind: 'remote-unreachable', targetId, message };
  }
}
