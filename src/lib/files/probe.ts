import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { nameFromDisposition } from './disposition';

/** What a check of one address found. */
export type ProbeResult =
  | {
      ok: true;
      /** The address of the file after every redirect. */
      finalUrl: string;
      /** Bytes. Always present: a file without a known size is not a result. */
      sizeBytes: number;
      mime?: string;
      /** The name the server gave (`Content-Disposition`). */
      serverName?: string;
    }
  | { ok: false; reason: 'status' | 'page' | 'size' | 'network' };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  fetch: FetchFn;
  /** Milliseconds before a request is given up. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PAGE_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

/** Statuses of a server that does not do `HEAD` (or does not do it for this file): ask with a one-byte range instead. */
const HEAD_REFUSED = new Set([400, 403, 405, 406, 501]);

function sizeFrom(response: Response): number | undefined {
  const range = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1];
  if (range !== undefined) return Number(range);
  if (response.status === 206) return undefined;
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

function judge(response: Response): ProbeResult {
  if (!(response.status === 200 || response.status === 206)) return { ok: false, reason: 'status' };
  const mime =
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
  if (mime && PAGE_TYPES.test(mime)) return { ok: false, reason: 'page' };
  const sizeBytes = sizeFrom(response);
  if (sizeBytes === undefined || sizeBytes <= 0) return { ok: false, reason: 'size' };
  const serverName = nameFromDisposition(response.headers.get('content-disposition'));
  return {
    ok: true,
    finalUrl: response.url || '',
    sizeBytes,
    ...(mime ? { mime } : {}),
    ...(serverName ? { serverName } : {}),
  };
}

async function ask(
  url: string,
  init: RequestInit,
  options: ProbeOptions,
): Promise<Response | undefined> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await options.fetch(url, {
      ...init,
      signal,
      credentials: 'include',
      redirect: 'follow',
    });
  } catch {
    return undefined;
  }
}

/**
 * Finds out whether an address is a downloadable file and how big it is. Redirects are followed to the real file. It
 * asks with `HEAD`; a server that refuses `HEAD`, or leaves the size out of it, is asked for one byte with `GET` and a
 * range, and that answer is dropped without reading its body. Only `HEAD` and a one-byte `GET` ever leave the browser.
 */
export async function probeFile(url: string, options: ProbeOptions): Promise<ProbeResult> {
  const head = await ask(url, { method: 'HEAD' }, options);
  if (head) {
    const result = judge(head);
    if (result.ok) return { ...result, finalUrl: result.finalUrl || url };
    if (result.reason === 'page') return result;
    if (!(HEAD_REFUSED.has(head.status) || result.reason === 'size')) return result;
  }
  const abort = new AbortController();
  const ranged = await ask(
    url,
    { method: 'GET', headers: { Range: 'bytes=0-0' } },
    {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
    },
  );
  if (!ranged) return { ok: false, reason: 'network' };
  // Only the headers are wanted: do not let a server that ignores `Range` send the whole file.
  const result = judge(ranged);
  abort.abort();
  return result.ok ? { ...result, finalUrl: result.finalUrl || url } : result;
}

/** Runs `work` on every item, at most `limit` at a time, in order of arrival; never rejects. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next];
      next += 1;
      if (item === undefined) continue;
      try {
        await work(item);
      } catch {
        // One failing check does not stop the others.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

interface Entry {
  url: string;
  result: ProbeResult;
  at: number;
}

function parseCache(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { url, result, at } = item as { url?: unknown; result?: unknown; at?: unknown };
    if (typeof url !== 'string' || typeof at !== 'number') return [];
    if (typeof result !== 'object' || result === null) return [];
    return [{ url, result: result as ProbeResult, at }];
  });
}

/** Results of checks, kept for ten minutes in `storage.session` so that reopening the panel does not ask again. */
export class ProbeCache {
  private readonly stored: StoredValue<Entry[]>;

  constructor(
    area: KeyValueArea,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.stored = new StoredValue(area, 'files.probe', parseCache);
  }

  async get(url: string): Promise<ProbeResult | undefined> {
    const now = this.now();
    return (await this.stored.get()).find(
      (entry) => entry.url === url && now - entry.at <= CACHE_TTL_MS,
    )?.result;
  }

  async put(url: string, result: ProbeResult): Promise<void> {
    const now = this.now();
    await this.stored.update((list) =>
      [
        ...list.filter((entry) => entry.url !== url && now - entry.at <= CACHE_TTL_MS),
        { url, result, at: now },
      ].slice(-CACHE_MAX),
    );
  }
}
