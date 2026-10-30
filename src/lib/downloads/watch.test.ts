import { describe, expect, it } from 'vitest';
import type { SseEvent } from '../api/sse';
import { silentLog } from '../log/log';
import { DownloadsService, type LiveSnapshot } from './service';

const task = (id: string, status = 'running') => ({
  id,
  name: id,
  status,
  downloaded: 0,
  size: 100,
  speed: 0,
  queueId: 'main',
  url: '',
});

const frame = (type: string, taskId: string, data: unknown = {}): SseEvent => ({
  id: undefined,
  event: type,
  data: JSON.stringify({ type, taskId, data }),
});

type Watch = (onEvent: (event: SseEvent) => void, signal: AbortSignal) => Promise<void>;

function service(port: { list: () => Promise<Omit<LiveSnapshot, 'reachable'>>; watch: Watch }) {
  return new DownloadsService({
    secrets: { get: () => Promise.resolve('t') },
    connection: {
      get: () =>
        Promise.resolve({
          kind: 'connected',
          targetId: 'local',
          baseUrl: 'http://127.0.0.1:1',
          version: '0.6.0',
        } as const),
    },
    log: silentLog,
    client: () => ({
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      move: () => Promise.resolve(),
      setTurbo: () => Promise.resolve(false),
      add: () => Promise.resolve(),
      ...port,
    }),
  });
}

const instantly = () => Promise.resolve();

/** Ends when the signal aborts, also when it already has (as a real stream does). */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve());
  });

describe('DownloadsService.watch', () => {
  it('sends the list, then every event, and stops when the popup closes', async () => {
    const seen: LiveSnapshot[] = [];
    const controller = new AbortController();
    const live = service({
      list: () => Promise.resolve({ tasks: [task('a')], queues: [], turbo: false }),
      watch: (onEvent, signal) =>
        (() => {
          onEvent(frame('task.progress', 'a', { downloaded: 40, size: 100, speed: 5 }));
          return untilAborted(signal);
        })(),
    });
    const done = live.watch((snapshot) => {
      seen.push(snapshot);
      if (seen.length === 2) controller.abort();
    }, controller.signal);
    await done;
    expect(seen[0]?.tasks[0]?.downloaded).toBe(0);
    expect(seen[1]?.tasks[0]).toMatchObject({ downloaded: 40, speed: 5 });
    expect(seen.every((snapshot) => snapshot.reachable)).toBe(true);
  });

  it('loads the list again after a reset event', async () => {
    let lists = 0;
    const controller = new AbortController();
    const seen: LiveSnapshot[] = [];
    const live = service({
      list: () => {
        lists += 1;
        return Promise.resolve({
          tasks: [task(lists === 1 ? 'a' : 'b')],
          queues: [],
          turbo: false,
        });
      },
      watch: (onEvent, signal) =>
        (() => {
          onEvent({ id: undefined, event: 'reset', data: '{"reason":"gap"}' });
          return untilAborted(signal);
        })(),
    });
    await live.watch((snapshot) => {
      seen.push(snapshot);
      if (snapshot.tasks[0]?.id === 'b') controller.abort();
    }, controller.signal);
    expect(lists).toBe(2);
  });

  it('says it cannot reach DLM when the stream breaks, and connects again with the list loaded anew', async () => {
    let attempts = 0;
    const controller = new AbortController();
    const seen: LiveSnapshot[] = [];
    const live = service({
      list: () => Promise.resolve({ tasks: [task('a')], queues: [], turbo: false }),
      watch: (_onEvent, signal) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('connection lost'));
        // The second stream is up: the person closes the popup.
        queueMicrotask(() => controller.abort());
        return untilAborted(signal);
      },
    });
    await live.watch((snapshot) => seen.push(snapshot), controller.signal, { wait: instantly });
    expect(attempts).toBe(2);
    expect(seen.map((snapshot) => snapshot.reachable)).toEqual([true, false, true]);
  });

  it('keeps retrying with a growing wait while DLM answers nothing', async () => {
    const waits: number[] = [];
    const controller = new AbortController();
    const live = service({
      list: () => Promise.reject(new Error('down')),
      watch: () => Promise.resolve(),
    });
    await live.watch(() => undefined, controller.signal, {
      wait: (ms) => {
        waits.push(ms);
        if (waits.length === 6) controller.abort();
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('loads the list on a timer, which keeps it fresh and the worker busy', async () => {
    let lists = 0;
    const controller = new AbortController();
    const live = service({
      list: () => {
        lists += 1;
        if (lists === 3) controller.abort();
        return Promise.resolve({ tasks: [], queues: [], turbo: false });
      },
      watch: (_onEvent, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    });
    await live.watch(() => undefined, controller.signal, { pollMs: 5 });
    expect(lists).toBeGreaterThanOrEqual(3);
  });

  it('survives a send that throws because the popup has gone', async () => {
    const controller = new AbortController();
    const live = service({
      list: () => Promise.resolve({ tasks: [], queues: [], turbo: false }),
      watch: (_e, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    });
    await expect(
      live.watch(
        () => {
          controller.abort();
          throw new Error('Attempting to use a disconnected port object');
        },
        controller.signal,
        { wait: instantly },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('DownloadsService.test', () => {
  it('has DLM download its own health report, and refuses when DLM is not connected', async () => {
    const added: string[] = [];
    const live = new DownloadsService({
      secrets: { get: () => Promise.resolve('t') },
      connection: {
        get: () =>
          Promise.resolve({
            kind: 'connected',
            targetId: 'local',
            baseUrl: 'http://127.0.0.1:50123',
            version: '0.6.0',
          } as const),
      },
      log: silentLog,
      client: () => ({
        list: () => Promise.resolve({ tasks: [], queues: [], turbo: false }),
        pause: () => Promise.resolve(),
        resume: () => Promise.resolve(),
        move: () => Promise.resolve(),
        setTurbo: () => Promise.resolve(false),
        add: (url) => {
          added.push(url);
          return Promise.resolve();
        },
        watch: () => Promise.resolve(),
      }),
    });
    await live.test();
    expect(added).toEqual(['http://127.0.0.1:50123/v1/health']);
    const away = new DownloadsService({
      secrets: { get: () => Promise.resolve('t') },
      connection: { get: () => Promise.resolve({ kind: 'app-not-running' } as const) },
      log: silentLog,
    });
    await expect(away.test()).rejects.toThrow('DLM is not connected.');
  });
});
