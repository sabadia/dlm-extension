import { silentLog, type Logger } from '../log/log';
import { redactUrl } from '../log/redact';
import { ApiError, NetworkError, problemFrom } from './errors';
import type { components, operations } from './schema';
import { readSse, type SseEvent } from './sse';

type Schemas = components['schemas'];

export type Health = Schemas['HealthOutputBody'];
export type WhoAmI = Schemas['WhoAmI'];
export type Task = Schemas['Task'];
export type TaskList = Schemas['TaskList'];
export type CaptureBody = Schemas['CaptureBody'];
export type CaptureCookie = Schemas['CaptureCookie'];
export type CaptureOutput = Schemas['CaptureOutput'];
export type ResolveResult = Schemas['ResolveResult'];
export type ResolveTaskBody = Schemas['ResolveTaskBody'];
export type TaskSelector = Schemas['TaskSelector'];
export type ListTasksQuery = NonNullable<operations['list-tasks']['parameters']['query']>;

/** `fetch` as the client needs it; tests pass a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** `http://127.0.0.1:50123`, `https://dlm.example.test/prefix`: no trailing slash. */
  baseUrl: string;
  /** The token of this extension on this server. Absent only for `health`. */
  token?: string;
  fetch?: FetchLike;
  log?: Logger;
  /** Milliseconds before an ordinary request gives up (the event stream has no timeout). Default 15 000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A small client for the parts of the daemon's REST API the extension uses. Types come from the pinned OpenAPI
 * document (`pnpm generate:api`). Every failure is an {@link ApiError} (the daemon answered) or a
 * {@link NetworkError} (it did not); neither carries the token.
 */
export class DlmClient {
  private readonly doFetch: FetchLike;
  private readonly log: Logger;

  constructor(private readonly options: ClientOptions) {
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.log = options.log ?? silentLog;
  }

  /** The daemon's identity and API range. Needs no token. */
  health(signal?: AbortSignal): Promise<Health> {
    return this.json('GET', '/v1/health', undefined, { signal, auth: false });
  }

  /** Who the token says it is (scope included). A revoked token fails with a 401 {@link ApiError}. */
  whoami(signal?: AbortSignal): Promise<WhoAmI> {
    return this.json('GET', '/v1/auth/whoami', undefined, { signal });
  }

  /** Hands a download of the browser to the daemon. */
  capture(body: CaptureBody, signal?: AbortSignal): Promise<CaptureOutput> {
    return this.json('POST', '/v1/capture', body, { signal });
  }

  listTasks(query: ListTasksQuery = {}, signal?: AbortSignal): Promise<TaskList> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const qs = params.toString();
    return this.json('GET', `/v1/tasks${qs ? `?${qs}` : ''}`, undefined, { signal });
  }

  getTask(id: string, signal?: AbortSignal): Promise<Task> {
    return this.json('GET', `/v1/tasks/${encodeURIComponent(id)}`, undefined, { signal });
  }

  /** Adds a task by address (a magnet link, a torrent URL, a page the daemon should open). */
  createTask(body: Schemas['CreateTaskBody'], signal?: AbortSignal): Promise<Task> {
    return this.json('POST', '/v1/tasks', body, { signal });
  }

  /** Adds many tasks. One failure does not stop the others. */
  createTasks(
    body: Schemas['CreateTasksBody'],
    signal?: AbortSignal,
  ): Promise<Schemas['BatchOutputBody']> {
    return this.json('POST', '/v1/tasks/batch', body, { signal });
  }

  /** The queues a context menu can offer. An extension token may list them. */
  listQueues(signal?: AbortSignal): Promise<Schemas['QueueList']> {
    return this.json('GET', '/v1/queues', undefined, { signal });
  }

  /**
   * Sends a `.torrent` file as the body (up to 16 MiB). Used when the file is behind cookies the daemon cannot send.
   * A public torrent URL goes through {@link createTask} instead.
   */
  async addTorrentFile(
    bytes: Uint8Array,
    query: { queueId?: string; name?: string; paused?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Task> {
    const params = new URLSearchParams();
    if (query.queueId) params.set('queueId', query.queueId);
    if (query.name) params.set('name', query.name);
    if (query.paused) params.set('paused', 'true');
    const qs = params.toString();
    const res = await this.send('POST', `/v1/tasks/torrent${qs ? `?${qs}` : ''}`, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-bittorrent' },
      body: new Blob([Uint8Array.from(bytes)]),
      signal,
    });
    return (await res.json()) as Task;
  }

  /** Moves tasks to the end of a queue. */
  moveTasks(
    body: { ids: string[]; queueId: string },
    signal?: AbortSignal,
  ): Promise<Schemas['BatchOutputBody']> {
    return this.json('POST', '/v1/tasks/move', body, { signal });
  }

  /** The speed limits in force, including a temporary turbo override. */
  limits(signal?: AbortSignal): Promise<Schemas['LimitsView']> {
    return this.json('GET', '/v1/limits', undefined, { signal });
  }

  /** Turns turbo on for an hour, or ends it. Turbo is an unlimited temporary speed limit. */
  turbo(on: boolean, signal?: AbortSignal): Promise<Schemas['LimitsView']> {
    if (!on) return this.json('DELETE', '/v1/limits/override', undefined, { signal });
    return this.json('POST', '/v1/limits/override', { speedLimit: 0, minutes: 60 }, { signal });
  }

  pauseTasks(selector: TaskSelector, signal?: AbortSignal): Promise<unknown> {
    return this.json('POST', '/v1/tasks/pause', selector, { signal });
  }

  resumeTasks(selector: TaskSelector, signal?: AbortSignal): Promise<unknown> {
    return this.json('POST', '/v1/tasks/resume', selector, { signal });
  }

  /** What a link is (size, name, formats) without adding it. */
  resolve(body: ResolveTaskBody, signal?: AbortSignal): Promise<ResolveResult> {
    return this.json('POST', '/v1/resolve', body, { signal });
  }

  /**
   * The live event stream. It ends when the daemon closes it or `signal` aborts; the caller reconnects (passing the
   * last event's `id`) and refetches state on a `reset` event. `types` limits the stream to those event types.
   */
  async *events(
    options: { signal?: AbortSignal; lastEventId?: string; types?: string[] } = {},
  ): AsyncGenerator<SseEvent> {
    const qs = options.types?.length ? `?types=${encodeURIComponent(options.types.join(','))}` : '';
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;
    const res = await this.send('GET', `/v1/events${qs}`, {
      headers,
      signal: options.signal,
      timeout: false,
    });
    if (!res.body) throw new NetworkError('The event stream has no body.');
    yield* readSse(res.body);
  }

  private async json<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { signal?: AbortSignal | undefined; auth?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.send(method, path, {
      headers,
      body: payload,
      signal: opts.signal,
      auth: opts.auth ?? true,
    });
    return (await res.json()) as T;
  }

  private async send(
    method: string,
    path: string,
    opts: {
      headers: Record<string, string>;
      body?: BodyInit | undefined;
      signal?: AbortSignal | undefined;
      auth?: boolean;
      timeout?: boolean;
    },
  ): Promise<Response> {
    const headers = { ...opts.headers };
    if (opts.auth !== false && this.options.token)
      headers.Authorization = `Bearer ${this.options.token}`;
    const timeout =
      opts.timeout === false
        ? undefined
        : AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signals = [opts.signal, timeout].filter((s): s is AbortSignal => s !== undefined);
    const init: RequestInit = {
      method,
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    };
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (combined) init.signal = combined;
    const url = `${this.options.baseUrl}${path}`;

    let res: Response;
    try {
      res = await this.doFetch(url, init);
    } catch (e) {
      const timedOut = timeout?.aborted === true && opts.signal?.aborted !== true;
      const reason = timedOut ? 'timed out' : e instanceof Error ? e.message : 'failed';
      this.log.debug('client', `${method} ${redactUrl(url)} ${reason}`);
      if (opts.signal?.aborted) throw e;
      throw new NetworkError(
        `Could not reach ${redactUrl(this.options.baseUrl)}: ${reason}`,
        timedOut,
      );
    }
    if (!res.ok) {
      const problem = await problemFrom(res);
      this.log.debug('client', `${method} ${redactUrl(url)} -> ${res.status}`, {
        code: problem.code,
      });
      throw problem;
    }
    return res;
  }
}

export { ApiError, NetworkError };
