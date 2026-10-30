/** One download in the popup. Built from a task and updated from the event stream. */
export interface LiveTask {
  id: string;
  name: string;
  status: string;
  downloaded: number;
  size: number;
  speed: number;
  queueId: string;
  /** Address to hand to the DLM app. */
  url: string;
}

/** The part of a task the list needs. */
export interface TaskLike {
  id: string;
  name?: string | undefined;
  status: string;
  downloaded: number;
  size: number;
  queueId: string;
  source?: { currentUrl?: string | undefined } | undefined;
}

export function liveFromTask(task: TaskLike): LiveTask {
  return {
    id: task.id,
    name: task.name && task.name !== '' ? task.name : 'download',
    status: task.status,
    downloaded: task.downloaded,
    size: task.size,
    speed: 0,
    queueId: task.queueId,
    url: task.source?.currentUrl ?? '',
  };
}

/**
 * Applies one server-sent event to the list. Unknown events and broken JSON are ignored. `reset` means the caller
 * should load the list again; this returns the list unchanged and reports that.
 */
export function applyLiveEvent(
  tasks: readonly LiveTask[],
  event: { event: string; data: string },
): { tasks: LiveTask[]; reset: boolean } {
  if (event.event === 'reset') return { tasks: [...tasks], reset: true };
  const frame = parseFrame(event.data);
  if (!frame) return { tasks: [...tasks], reset: false };
  const type = frame.type || event.event;
  if (type === 'task.created' && isTaskLike(frame.data)) {
    return { tasks: upsert(tasks, liveFromTask(frame.data)), reset: false };
  }
  if (type === 'task.deleted') {
    const id = frame.taskId;
    return { tasks: id ? tasks.filter((task) => task.id !== id) : [...tasks], reset: false };
  }
  if (type === 'task.status') {
    const id = frame.taskId;
    const to = record(frame.data)?.to;
    if (!id || typeof to !== 'string') return { tasks: [...tasks], reset: false };
    return {
      tasks: tasks.map((task) =>
        task.id === id ? { ...task, status: to, speed: to === 'running' ? task.speed : 0 } : task,
      ),
      reset: false,
    };
  }
  if (type === 'task.progress') {
    const id = frame.taskId;
    const data = record(frame.data);
    if (!id || !data) return { tasks: [...tasks], reset: false };
    return {
      tasks: tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              downloaded: numberOr(data.downloaded, task.downloaded),
              size: numberOr(data.size, task.size),
              speed: numberOr(data.speed, task.speed),
              status: 'running',
            }
          : task,
      ),
      reset: false,
    };
  }
  return { tasks: [...tasks], reset: false };
}

/** Bytes as a short label. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1000) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

/** `dlm://add?url=` opens the running DLM app on this address. */
export function openInAppUrl(url: string): string {
  return `dlm://add?url=${encodeURIComponent(url)}`;
}

interface Frame {
  type: string;
  taskId?: string;
  data?: unknown;
}

function parseFrame(data: string): Frame | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    const body = record(parsed);
    if (!body) return undefined;
    const type = typeof body.type === 'string' ? body.type : '';
    const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
    return {
      type,
      ...(taskId ? { taskId } : {}),
      ...(body.data !== undefined ? { data: body.data } : {}),
    };
  } catch {
    return undefined;
  }
}

function isTaskLike(value: unknown): value is TaskLike {
  const body = record(value);
  return (
    !!body &&
    typeof body.id === 'string' &&
    typeof body.status === 'string' &&
    typeof body.queueId === 'string'
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function upsert(tasks: readonly LiveTask[], task: LiveTask): LiveTask[] {
  const rest = tasks.filter((item) => item.id !== task.id);
  return [task, ...rest].slice(0, 100);
}
