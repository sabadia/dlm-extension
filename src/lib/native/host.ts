import { silentLog, type Logger } from '../log/log';
import { redactText } from '../log/redact';
import { atLeast, checkCompatibility, type Compatibility } from './compat';

/** The Native Messaging host the daemon installs (`dlm native-host install`). */
/**
 * A daemon from 0.7 on reports its API version, but the native host may leave it out when it found the daemon by its
 * address. Only a daemon older than that is taken as too old for lacking it.
 */
function missingApiVersion(version: string | undefined): number | undefined {
  return version !== undefined && atLeast(version, '0.7.0') ? undefined : 0;
}

export const HOST_NAME = 'dev.sabadia.dlm';

/** The part of `browser.runtime` used to talk to the host. */
export interface NativeRuntime {
  sendNativeMessage(host: string, message: unknown): Promise<unknown>;
}

export type NativeFailureKind =
  /** No host is registered with this browser: DLM is not installed, or its host was never registered. */
  | 'host-not-installed'
  /** The host is registered but refuses this extension (its id is not in the host manifest). */
  | 'host-not-allowed'
  /** The host started and failed or exited. */
  | 'host-failed'
  /** No answer in time. On macOS the first start can wait for a system permission. */
  | 'timeout';

export class NativeError extends Error {
  constructor(
    readonly kind: NativeFailureKind,
    message: string,
  ) {
    super(redactText(message));
    this.name = 'NativeError';
  }
}

/**
 * Sorts a browser's native-messaging error text into a kind. The wording differs between Chrome ("Specified native
 * messaging host not found.", "Access to the specified native messaging host is forbidden.", "Native host has exited.")
 * and Firefox ("No such native application dev.sabadia.dlm"); unknown text is a failure of the host.
 */
export function classifyNativeError(message: string): NativeFailureKind {
  const text = message.toLowerCase();
  if (/not found|no such native application|not installed/.test(text)) return 'host-not-installed';
  if (/forbidden|not allowed|permission denied/.test(text)) return 'host-not-allowed';
  return 'host-failed';
}

/** What `connect` finds out about the daemon of this computer. */
export type Discovery =
  | {
      state: 'found';
      /** Where the daemon listens now (it may have picked a new port since the extension last looked). */
      baseUrl: string;
      version: string;
      apiVersion: number;
      /** Set when the daemon serves HTTPS with its own certificate. */
      tlsFingerprint?: string;
    }
  | { state: 'app-not-running'; lastKnownBaseUrl?: string }
  | {
      state: 'incompatible';
      compatibility: Exclude<Compatibility, { ok: true }>;
      version?: string;
      apiVersion?: number;
    }
  | {
      state: 'host-not-installed' | 'host-not-allowed' | 'host-failed' | 'timeout';
      message: string;
    };

interface ConnectReply {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  baseUrl?: unknown;
  running?: unknown;
  version?: unknown;
  apiVersion?: unknown;
  tlsFingerprint?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingReply {
  pairingId: string;
  status: PairingStatus;
  /** The six digits shown here and in the DLM app. */
  code: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Only on the first reply after approval. A secret: store it, never log it. */
  token?: string;
}

const STATUSES: readonly string[] = ['pending', 'approved', 'denied', 'expired'];

function readPairing(reply: Record<string, unknown>): PairingReply {
  if (reply.ok !== true) {
    const code = str(reply.error);
    if (code === 'origin_not_allowed')
      throw new NativeError(
        'host-not-allowed',
        str(reply.message) ?? 'The host refuses this extension.',
      );
    throw new NativeError('host-failed', str(reply.message) ?? code ?? 'The pairing was refused.');
  }
  const status = str(reply.status);
  const pairingId = str(reply.pairingId);
  if (!status || !STATUSES.includes(status) || !pairingId)
    throw new NativeError('host-failed', 'The DLM host sent an unreadable pairing reply.');
  const expires = typeof reply.expiresAt === 'string' ? Date.parse(reply.expiresAt) : NaN;
  const token = str(reply.token);
  return {
    pairingId,
    status: status as PairingStatus,
    code: str(reply.code) ?? '',
    expiresAt: Number.isFinite(expires) ? expires : 0,
    ...(token !== undefined ? { token } : {}),
  };
}

export interface HostOptions {
  /** Milliseconds to wait for the host. Default 20 000. */
  timeoutMs?: number;
  log?: Logger;
}

/** A client for the native host: one process per request (`sendNativeMessage`), nothing kept between them. */
export class NativeHost {
  private readonly log: Logger;

  constructor(
    private readonly runtime: NativeRuntime,
    private readonly options: HostOptions = {},
  ) {
    this.log = options.log ?? silentLog;
  }

  /** Sends one request and returns the reply object. Throws {@link NativeError}. */
  async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timeoutMs = this.options.timeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new NativeError('timeout', `The DLM host did not answer within ${timeoutMs / 1000} s.`),
          ),
        timeoutMs,
      );
    });
    try {
      const reply = await Promise.race([
        this.runtime.sendNativeMessage(HOST_NAME, message),
        timeout,
      ]);
      if (typeof reply !== 'object' || reply === null)
        throw new NativeError('host-failed', 'The DLM host sent an unreadable reply.');
      return reply as Record<string, unknown>;
    } catch (e) {
      if (e instanceof NativeError) throw e;
      const text = e instanceof Error ? e.message : String(e);
      throw new NativeError(classifyNativeError(text), text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the host starts and answers. */
  async ping(): Promise<boolean> {
    try {
      return (await this.request({ type: 'ping' })).ok === true;
    } catch {
      return false;
    }
  }

  /** Asks the daemon, through the host, for a pairing. The user then compares `code` and answers in the DLM app. */
  async pair(who: { name: string; browser: string; version: string }): Promise<PairingReply> {
    return readPairing(await this.request({ type: 'pair', ...who }));
  }

  /** The state of a pairing. The reply to the first call after approval carries the token, once. */
  async pairStatus(pairingId: string): Promise<PairingReply> {
    return readPairing(await this.request({ type: 'pair.status', pairingId }));
  }

  /**
   * Asks the host where the daemon is. Never throws: every outcome is a {@link Discovery} state, so the connection
   * state machine (E1.6) maps states to what the person sees.
   */
  async connect(): Promise<Discovery> {
    let reply: ConnectReply;
    try {
      reply = await this.request({ type: 'connect' });
    } catch (e) {
      const error = e instanceof NativeError ? e : new NativeError('host-failed', String(e));
      this.log.info('native', `connect failed: ${error.kind}`, { message: error.message });
      return { state: error.kind, message: error.message };
    }
    if (reply.ok !== true) {
      const code = str(reply.error);
      const message = str(reply.message) ?? code ?? 'The DLM host refused the request.';
      this.log.info('native', 'connect refused', { code, message });
      return {
        state: code === 'origin_not_allowed' ? 'host-not-allowed' : 'host-failed',
        message: redactText(message),
      };
    }
    const baseUrl = str(reply.baseUrl);
    if (reply.running !== true || baseUrl === undefined) {
      return baseUrl === undefined
        ? { state: 'app-not-running' }
        : { state: 'app-not-running', lastKnownBaseUrl: baseUrl };
    }
    const version = str(reply.version);
    const apiVersion = typeof reply.apiVersion === 'number' ? reply.apiVersion : undefined;
    const compatibility = checkCompatibility({
      version,
      apiVersion: apiVersion ?? missingApiVersion(version),
    });
    if (!compatibility.ok) {
      this.log.warn('native', 'daemon is not compatible', {
        version,
        apiVersion,
        reason: compatibility.reason,
      });
      return {
        state: 'incompatible',
        compatibility,
        ...(version !== undefined ? { version } : {}),
        ...(apiVersion !== undefined ? { apiVersion } : {}),
      };
    }
    const tls = str(reply.tlsFingerprint);
    return {
      state: 'found',
      baseUrl,
      version: version ?? '',
      apiVersion: apiVersion ?? 0,
      ...(tls !== undefined ? { tlsFingerprint: tls } : {}),
    };
  }
}
