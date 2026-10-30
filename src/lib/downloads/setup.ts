import type { ConnectionState } from '../connection/state';

export type SetupStep = 'app' | 'host' | 'pair' | 'access' | 'test';

/**
 * Where setup stands. The steps are about the DLM on this computer: for a server added by URL the host and the pairing
 * do not apply, so they count as done. `siteAccess` is whether the browser lets the extension reach every site (Firefox
 * grants that only when asked); `kind` is the state of the connection.
 */
export function setupSteps(
  kind: ConnectionState['kind'],
  siteAccess: boolean,
): { id: SetupStep; done: boolean }[] {
  const remote = kind === 'remote-needs-token' || kind === 'remote-unreachable';
  const hostMissing =
    kind === 'checking' ||
    kind === 'host-not-installed' ||
    kind === 'host-not-allowed' ||
    kind === 'host-failed';
  const appAway = kind === 'app-not-running';
  const host = remote || (!hostMissing && !appAway);
  const needsPairing = kind === 'needs-pairing' || kind === 'pairing' || kind === 'token-revoked';
  const paired = remote || (host && !needsPairing && kind !== 'access-needed');
  return [
    { id: 'app', done: remote || (kind !== 'checking' && !appAway) },
    { id: 'host', done: host },
    { id: 'pair', done: paired },
    { id: 'access', done: siteAccess && kind !== 'access-needed' },
    { id: 'test', done: kind === 'connected' },
  ];
}
