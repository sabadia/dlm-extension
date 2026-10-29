import type { Compatibility } from '../native/compat';
import type { MessageKey } from '../i18n/en';

/** Where the connection to DLM stands. One value, shown by the badge, the tooltip, the popup and the options. */
export type ConnectionState =
  /** Not looked yet, or looking. */
  | { kind: 'checking' }
  /** No native host is registered: DLM is not installed, or not set up for this browser. */
  | { kind: 'host-not-installed' }
  /** The host is registered for other extension ids and refuses this one. */
  | { kind: 'host-not-allowed' }
  | { kind: 'host-failed'; message: string }
  /** The host works but DLM is not running. */
  | { kind: 'app-not-running' }
  /** DLM runs but its address cannot be reached from the browser (a self-signed HTTPS certificate, a firewall). */
  | { kind: 'local-unreachable'; https: boolean }
  /** DLM runs and no token is stored: the first connection. */
  | { kind: 'needs-pairing' }
  /** Waiting for the person to answer in the DLM app. */
  | { kind: 'pairing' }
  /** The token is refused: it was revoked (or the server was reset). Pair again. */
  | { kind: 'token-revoked' }
  /** The browser has not let the extension call this server yet (Firefox asks at the first use). */
  | { kind: 'access-needed'; origin: string }
  | { kind: 'incompatible'; compatibility: Exclude<Compatibility, { ok: true }> }
  | { kind: 'remote-needs-token'; targetId: string }
  | { kind: 'remote-unreachable'; targetId: string; message: string }
  | { kind: 'connected'; targetId: string; baseUrl: string; version: string };

export type ConnectionKind = ConnectionState['kind'];

export function isConnected(
  state: ConnectionState,
): state is Extract<ConnectionState, { kind: 'connected' }> {
  return state.kind === 'connected';
}

/** The catalogue key of the one-line description of each state (the tooltip, the first line of the popup). */
export const STATE_TEXT: Record<ConnectionKind, MessageKey> = {
  checking: 'state.checking',
  'host-not-installed': 'state.hostNotInstalled',
  'host-not-allowed': 'state.hostNotAllowed',
  'host-failed': 'state.hostFailed',
  'app-not-running': 'state.appNotRunning',
  'local-unreachable': 'state.localUnreachable',
  'access-needed': 'state.accessNeeded',
  'needs-pairing': 'state.needsPairing',
  pairing: 'state.pairing',
  'token-revoked': 'state.tokenRevoked',
  incompatible: 'state.incompatible',
  'remote-needs-token': 'state.remoteNeedsToken',
  'remote-unreachable': 'state.remoteUnreachable',
  connected: 'state.connected',
};

export interface Badge {
  /** At most four characters; empty hides the badge. */
  text: string;
  /** `#rrggbb`. */
  color: string;
}

const RED = '#c62828';
const AMBER = '#b26a00';
const BLUE = '#1565c0';

/** The toolbar badge of a state. Healthy and quiet states show none (the download count comes in E5). */
export function badgeFor(state: ConnectionState, enabled: boolean): Badge {
  if (!enabled) return { text: '', color: BLUE };
  switch (state.kind) {
    case 'connected':
    case 'checking':
      return { text: '', color: BLUE };
    case 'access-needed':
    case 'needs-pairing':
    case 'pairing':
      return { text: '…', color: BLUE };
    case 'app-not-running':
    case 'remote-unreachable':
    case 'local-unreachable':
      return { text: '!', color: AMBER };
    default:
      return { text: '!', color: RED };
  }
}
