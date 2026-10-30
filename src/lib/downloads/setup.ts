import type { ConnectionState } from '../connection/state';

/** Where setup stands, from the connection. */
export function setupSteps(kind: ConnectionState['kind']): { id: string; done: boolean }[] {
  const host =
    kind !== 'checking' &&
    kind !== 'host-not-installed' &&
    kind !== 'host-not-allowed' &&
    kind !== 'host-failed' &&
    kind !== 'app-not-running';
  const paired = host && kind !== 'needs-pairing' && kind !== 'pairing' && kind !== 'token-revoked';
  const access = paired && kind !== 'access-needed';
  return [
    { id: 'app', done: kind !== 'app-not-running' && kind !== 'checking' },
    { id: 'host', done: host },
    { id: 'pair', done: paired },
    { id: 'access', done: access },
    { id: 'test', done: kind === 'connected' },
  ];
}
