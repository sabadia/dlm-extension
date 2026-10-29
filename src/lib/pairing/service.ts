import type { Logger } from '../log/log';
import type { NativeHost, PairingReply } from '../native/host';
import { NativeError } from '../native/host';
import type { SecretStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { LOCAL_TARGET } from '../settings/schema';

/** What the pages show. It never holds the token. */
export type PairingView =
  | { phase: 'idle' }
  /** Waiting for the person to compare `code` and press Allow in the DLM app. */
  | { phase: 'pending'; code: string; expiresAt: number }
  | { phase: 'approved' }
  | { phase: 'denied' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string };

/** What survives a restart of the worker: the pairing in progress. */
interface Progress {
  pairingId: string;
  code: string;
  expiresAt: number;
}

const KEY = 'pairing';

function parseProgress(raw: unknown): Progress | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.pairingId !== 'string' ||
    typeof r.code !== 'string' ||
    typeof r.expiresAt !== 'number'
  )
    return undefined;
  return { pairingId: r.pairingId, code: r.code, expiresAt: r.expiresAt };
}

export interface PairingDeps {
  host: Pick<NativeHost, 'pair' | 'pairStatus'>;
  secrets: Pick<SecretStore, 'set'>;
  /** Where the pairing in progress is kept: `storage.session`. */
  area: KeyValueArea;
  /** The name of this browser for the daemon (see `detectBrowser`) and the extension version. */
  browser: string;
  version: string;
  log: Logger;
  now?: () => number;
}

/**
 * Pairs the extension with the DLM on this computer: `start` asks, the person compares the code and allows it in the
 * app, `poll` (called every couple of seconds by whichever page is open) picks the answer up and stores the token.
 * Everything between calls is in storage, so a worker that is stopped and started again carries on. The token goes
 * straight from the host's reply into the secret store; it is not logged, returned or kept anywhere else.
 */
export class PairingService {
  private readonly progress: StoredValue<Progress | undefined>;

  constructor(private readonly deps: PairingDeps) {
    this.progress = new StoredValue<Progress | undefined>(deps.area, KEY, parseProgress);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Where things stand, without asking the host. */
  async view(): Promise<PairingView> {
    const p = await this.progress.get();
    if (!p) return { phase: 'idle' };
    if (p.expiresAt > 0 && p.expiresAt <= this.now()) {
      await this.progress.set(undefined);
      return { phase: 'expired' };
    }
    return { phase: 'pending', code: p.code, expiresAt: p.expiresAt };
  }

  /** Asks for a new pairing, replacing one in progress. */
  async start(): Promise<PairingView> {
    try {
      const reply = await this.deps.host.pair({
        name: `${this.deps.browser[0]?.toUpperCase() ?? ''}${this.deps.browser.slice(1)} extension`,
        browser: this.deps.browser,
        version: this.deps.version,
      });
      if (reply.status !== 'pending') return await this.settle(reply);
      await this.progress.set({
        pairingId: reply.pairingId,
        code: reply.code,
        expiresAt: reply.expiresAt,
      });
      this.deps.log.info('pairing', 'asked to pair', { code: reply.code });
      return { phase: 'pending', code: reply.code, expiresAt: reply.expiresAt };
    } catch (e) {
      return this.failed(e);
    }
  }

  /** Asks the host how the pairing stands; on approval stores the token. Safe to call at any time. */
  async poll(): Promise<PairingView> {
    const p = await this.progress.get();
    if (!p) return { phase: 'idle' };
    try {
      return await this.settle(await this.deps.host.pairStatus(p.pairingId));
    } catch (e) {
      return this.failed(e);
    }
  }

  /** Forgets the pairing in progress (the daemon drops it on its own after two minutes). */
  async cancel(): Promise<PairingView> {
    await this.progress.set(undefined);
    return { phase: 'idle' };
  }

  private async settle(reply: PairingReply): Promise<PairingView> {
    switch (reply.status) {
      case 'pending':
        await this.progress.set({
          pairingId: reply.pairingId,
          code: reply.code,
          expiresAt: reply.expiresAt,
        });
        return this.view();
      case 'approved': {
        if (reply.token === undefined) {
          // The token is handed out once; this reply came after it was taken.
          await this.progress.set(undefined);
          this.deps.log.warn('pairing', 'approved but the token was already taken');
          return {
            phase: 'error',
            message: 'The pairing was approved but the token did not arrive. Pair again.',
          };
        }
        await this.deps.secrets.set(LOCAL_TARGET.id, reply.token);
        await this.progress.set(undefined);
        this.deps.log.info('pairing', 'paired');
        return { phase: 'approved' };
      }
      case 'denied':
      case 'expired':
        await this.progress.set(undefined);
        this.deps.log.info('pairing', `pairing ${reply.status}`);
        return { phase: reply.status };
    }
  }

  private failed(e: unknown): PairingView {
    const message =
      e instanceof NativeError || e instanceof Error ? e.message : 'The pairing failed.';
    this.deps.log.warn('pairing', 'pairing failed', { error: e });
    return { phase: 'error', message };
  }
}
