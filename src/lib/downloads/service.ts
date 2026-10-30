import { DlmClient, type Task } from '../api/client';
import type { SseEvent } from '../api/sse';
import type { ConnectionService } from '../connection/service';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import type { SecretStore } from '../settings/store';
import { applyLiveEvent, liveFromTask, type LiveTask } from './live';

export interface LiveSnapshot {
  tasks: LiveTask[];
  queues: { id: string; name: string }[];
  /** True while a temporary unlimited speed limit is in force. */
  turbo: boolean;
  /** False while DLM cannot be reached and the list may be out of date. */
  reachable: boolean;
}

interface LivePort {
  list(): Promise<Omit<LiveSnapshot, 'reachable'>>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  move(id: string, queueId: string): Promise<void>;
  setTurbo(on: boolean): Promise<boolean>;
  add(url: string): Promise<void>;
  watch(onEvent: (event: SseEvent) => void, signal: AbortSignal): Promise<void>;
}

export interface DownloadsDeps {
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get'>;
  log: Logger;
  client?: (baseUrl: string, token: string) => LivePort;
}

/** The popup's live list. The stream runs only while the popup is connected. */
export class DownloadsService {
  constructor(private readonly deps: DownloadsDeps) {}

  list(): Promise<LiveSnapshot> {
    return this.withPort(
      async (port) => ({ ...(await port.list()), reachable: true }),
      emptySnapshot(),
    );
  }

  pause(id: string): Promise<void> {
    return this.withPort((port) => port.pause(id), undefined);
  }

  resume(id: string): Promise<void> {
    return this.withPort((port) => port.resume(id), undefined);
  }

  move(id: string, queueId: string): Promise<void> {
    return this.withPort((port) => port.move(id, queueId), undefined);
  }

  setTurbo(on: boolean): Promise<boolean> {
    return this.withPort((port) => port.setTurbo(on), false);
  }

  /**
   * A test download: DLM fetches its own health report. It is a real file from a real address that DLM can reach from
   * where it runs (a made-up address never resolves), it needs no login, and it is small.
   */
  async test(): Promise<void> {
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') throw new Error(t('links.offline'));
    await this.withPort((port) => port.add(`${state.baseUrl}/v1/health`), undefined);
  }

  /**
   * Pushes the list and then every relevant event until `signal` aborts (the popup closed). When the stream ends or
   * DLM goes away it tries again with a growing wait, and loads the list again each time, so the list is never left
   * stale without saying so (`reachable`). It also loads the list every `pollMs`: this closes any gap between loading
   * and the stream starting, and the traffic keeps a Chrome service worker from being stopped while the popup is open.
   * A send that fails (the popup closed meanwhile) ends the watch.
   */
  async watch(
    send: (snapshot: LiveSnapshot) => void,
    signal: AbortSignal,
    options: { pollMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
  ): Promise<void> {
    const pollMs = options.pollMs ?? POLL_MS;
    const wait = options.wait ?? abortableWait;
    let snapshot = emptySnapshot();
    const emit = (next: LiveSnapshot) => {
      snapshot = next;
      send(next);
    };
    let delay = FIRST_RETRY_MS;
    while (!signal.aborted) {
      const port = await this.port();
      if (!port) {
        // Not connected to DLM at all (not set up, not running): there is no list to be stale. The popup says why.
        emit(emptySnapshot());
        await wait(NO_PORT_RETRY_MS, signal);
        continue;
      }
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      signal.addEventListener('abort', stop, { once: true });
      const relist = async () => {
        try {
          emit({ ...(await port.list()), reachable: true });
        } catch (error) {
          this.deps.log.debug('downloads', 'could not load the list', { error });
        }
      };
      const timer = setInterval(() => void relist(), pollMs);
      try {
        emit({ ...(await port.list()), reachable: true });
        delay = FIRST_RETRY_MS;
        await port.watch((event) => {
          const next = applyLiveEvent(snapshot.tasks, event);
          if (next.reset || event.event === 'limits.changed') {
            void relist();
            return;
          }
          emit({ ...snapshot, tasks: next.tasks });
        }, attempt.signal);
      } catch (error) {
        if (signal.aborted) break;
        this.deps.log.debug('downloads', 'the live stream stopped', { error });
        emit({ ...snapshot, reachable: false });
      } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
        attempt.abort();
      }
      await wait(delay, signal);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  private async withPort<T>(run: (port: LivePort) => Promise<T>, fallback: T): Promise<T> {
    const port = await this.port();
    if (!port) return fallback;
    return run(port);
  }

  private async port(): Promise<LivePort | undefined> {
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') return undefined;
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) return undefined;
    return (this.deps.client ?? daemonPort)(state.baseUrl, token);
  }
}

const POLL_MS = 15_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
const NO_PORT_RETRY_MS = 5_000;

function emptySnapshot(): LiveSnapshot {
  return { tasks: [], queues: [], turbo: false, reachable: true };
}

/** Waits `ms`, or less when `signal` aborts. */
function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function daemonPort(baseUrl: string, token: string): LivePort {
  const client = new DlmClient({ baseUrl, token });
  return {
    async list() {
      const [tasks, queues, limits] = await Promise.all([
        client.listTasks({ limit: 50 }),
        client.listQueues(),
        client.limits(),
      ]);
      return {
        tasks: (tasks.tasks ?? []).map((task) => liveFromTask(asTask(task))),
        queues: (queues.queues ?? []).map((queue) => ({ id: queue.id, name: queue.name })),
        turbo: limits.override?.speedLimit === 0,
      };
    },
    async pause(id) {
      await client.pauseTasks({ ids: [id] });
    },
    async resume(id) {
      await client.resumeTasks({ ids: [id] });
    },
    async move(id, queueId) {
      await client.moveTasks({ ids: [id], queueId });
    },
    setTurbo(on) {
      return client.turbo(on).then((view) => view.override?.speedLimit === 0);
    },
    async add(url) {
      await client.createTask({ url });
    },
    async watch(onEvent, signal) {
      try {
        const stream = client.events({
          signal,
          types: [
            'task.progress',
            'task.status',
            'task.created',
            'task.deleted',
            'limits.changed',
            'reset',
          ],
        });
        for await (const event of stream) onEvent(event);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    },
  };
}

function asTask(task: Task): Parameters<typeof liveFromTask>[0] {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    downloaded: task.downloaded,
    size: task.size,
    queueId: task.queueId,
    source: { currentUrl: task.source.currentUrl },
  };
}
