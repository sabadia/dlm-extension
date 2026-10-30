import { DlmClient, type Task } from '../api/client';
import type { SseEvent } from '../api/sse';
import type { ConnectionService } from '../connection/service';
import type { Logger } from '../log/log';
import type { SecretStore } from '../settings/store';
import { applyLiveEvent, liveFromTask, type LiveTask } from './live';

export interface LiveSnapshot {
  tasks: LiveTask[];
  queues: { id: string; name: string }[];
  /** True while a temporary unlimited speed limit is in force. */
  turbo: boolean;
}

interface LivePort {
  list(): Promise<LiveSnapshot>;
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
    return this.withPort((port) => port.list(), emptySnapshot());
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

  test(url: string): Promise<void> {
    return this.withPort((port) => port.add(url), undefined);
  }

  /** Pushes the list, then each relevant event, until `signal` aborts (the popup closed). */
  async watch(send: (snapshot: LiveSnapshot) => void, signal: AbortSignal): Promise<void> {
    const port = await this.port();
    if (!port) {
      send(emptySnapshot());
      return;
    }
    let snapshot = await port.list();
    send(snapshot);
    await port.watch((event) => {
      const next = applyLiveEvent(snapshot.tasks, event);
      snapshot = { ...snapshot, tasks: next.tasks };
      if (next.reset) {
        void port.list().then(
          (fresh) => {
            snapshot = fresh;
            send(fresh);
          },
          () => undefined,
        );
        return;
      }
      if (event.event === 'limits.changed') {
        void port.list().then(
          (fresh) => {
            snapshot = { ...snapshot, turbo: fresh.turbo };
            send(snapshot);
          },
          () => undefined,
        );
        return;
      }
      send(snapshot);
    }, signal);
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

function emptySnapshot(): LiveSnapshot {
  return { tasks: [], queues: [], turbo: false };
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
