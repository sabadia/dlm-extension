import { describe, expect, it } from 'vitest';
import { silentLog } from '../log/log';
import { defaultSettings, type Settings } from '../settings/schema';
import { memoryArea } from '../storage/area';
import { REFRESH_PREFIX, RefreshService } from './service';
import type { WaitingTask } from './watch';

const task = (id: string, page = 'https://files.example.test/setup'): WaitingTask => ({
  id,
  status: 'awaiting_link',
  name: `Setup ${id}`,
  source: { pageUrl: page },
});

interface Server {
  baseUrl: string;
  tasks: WaitingTask[] | 'down';
}

function build(over: { notifications?: boolean; refresh?: boolean; servers?: Server[] } = {}) {
  const servers: Server[] = over.servers ?? [
    { baseUrl: 'http://127.0.0.1:1', tasks: [task('t1')] },
  ];
  const opened: string[] = [];
  const notes: { id: string; title: string; message: string }[] = [];
  const settings: Settings = {
    ...defaultSettings(),
    preferences: {
      ...defaultSettings().preferences,
      notifications: over.notifications ?? true,
      refresh: over.refresh ?? true,
    },
  };
  const local = memoryArea();
  const session = memoryArea();
  const lookups = { count: 0 };
  let clock = 1000;
  const refresh = new RefreshService({
    endpoints: () => Promise.resolve(servers.map((s) => ({ baseUrl: s.baseUrl, token: 't' }))),
    settings: { get: () => Promise.resolve(settings) },
    notifications: {
      create: (id, options) => {
        notes.push({ id, title: options.title, message: options.message });
      },
    },
    open: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    local,
    session,
    log: silentLog,
    now: () => clock,
    tasks: (baseUrl) => ({
      listTasks: () => {
        lookups.count += 1;
        const server = servers.find((s) => s.baseUrl === baseUrl);
        if (!server || server.tasks === 'down') return Promise.reject(new Error('down'));
        return Promise.resolve({ tasks: server.tasks });
      },
    }),
  });
  return {
    refresh,
    opened,
    notes,
    servers,
    local,
    lookups,
    clock: { advance: (ms: number) => (clock += ms) },
  };
}

describe('RefreshService', () => {
  it('notifies once, opens nothing by itself, and opens the page when the notification is clicked', async () => {
    const { refresh, opened, notes } = build();
    await refresh.scan();
    await refresh.scan();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'Setup t1',
      message: 'Link expired: click to open the page',
    });
    expect(notes[0]?.id.startsWith(REFRESH_PREFIX)).toBe(true);
    expect(opened).toEqual([]);
    expect(await refresh.onNotificationClicked(notes[0]?.id ?? '')).toBe(true);
    expect(opened).toEqual(['https://files.example.test/setup']);
    // The click is spent; a notification that is not ours is not handled.
    await refresh.onNotificationClicked(notes[0]?.id ?? '');
    expect(opened).toHaveLength(1);
    expect(await refresh.onNotificationClicked('dlm-duplicate:x')).toBe(false);
  });

  it('opens nothing and notifies nothing when notifications are off, and does not look when the switch is off', async () => {
    const quiet = build({ notifications: false });
    await quiet.refresh.scan();
    expect(quiet.notes).toEqual([]);
    expect(quiet.opened).toEqual([]);
    const off = build({ refresh: false });
    await off.refresh.scan();
    expect(off.lookups.count).toBe(0);
    expect(off.notes).toEqual([]);
  });

  it('never opens an address that is not a web page', async () => {
    const { refresh, notes, opened } = build({
      servers: [{ baseUrl: 'http://127.0.0.1:1', tasks: [task('t1', 'javascript:alert(1)')] }],
    });
    await refresh.scan();
    expect(notes[0]?.message).toContain('open the page you started it from');
    await refresh.onNotificationClicked(notes[0]?.id ?? '');
    expect(opened).toEqual([]);
  });

  it('does not tell again about a task of a server that failed once and came back', async () => {
    const { refresh, notes, servers } = build({
      servers: [
        { baseUrl: 'http://a', tasks: [task('1')] },
        { baseUrl: 'http://b', tasks: [task('1', 'https://b.example.test/')] },
      ],
    });
    await refresh.scan();
    expect(notes).toHaveLength(2); // the same id on two servers is two tasks
    servers[0] = { baseUrl: 'http://a', tasks: 'down' };
    await refresh.scan();
    servers[0] = { baseUrl: 'http://a', tasks: [task('1')] };
    await refresh.scan();
    expect(notes).toHaveLength(2);
  });

  it('tells again about a task that stopped waiting and came back, and after a week', async () => {
    const { refresh, notes, servers, clock } = build();
    await refresh.scan();
    servers[0] = { baseUrl: 'http://127.0.0.1:1', tasks: [] };
    await refresh.scan();
    servers[0] = { baseUrl: 'http://127.0.0.1:1', tasks: [task('t1')] };
    await refresh.scan();
    expect(notes).toHaveLength(2);
    clock.advance(8 * 24 * 60 * 60 * 1000);
    await refresh.scan();
    expect(notes).toHaveLength(3);
  });

  it('keeps what it showed in storage.local, so a browser restart does not repeat it', async () => {
    const { refresh, local } = build();
    await refresh.scan();
    expect(await local.get('refresh.seen')).toHaveLength(1);
  });

  it('names the server that waits for a download from a page, and forgets it after an hour', async () => {
    const { refresh, clock } = build();
    await refresh.scan();
    expect((await refresh.endpointFor('https://files.example.test/other/page'))?.baseUrl).toBe(
      'http://127.0.0.1:1',
    );
    expect((await refresh.endpointFor('https://www.files.example.test/x'))?.baseUrl).toBe(
      'http://127.0.0.1:1',
    );
    expect(await refresh.endpointFor('https://elsewhere.test/')).toBeUndefined();
    expect(await refresh.endpointFor(undefined)).toBeUndefined();
    clock.advance(61 * 60 * 1000);
    expect(await refresh.endpointFor('https://files.example.test/')).toBeUndefined();
  });

  it('stops naming a server once it no longer lists the task, but keeps one that did not answer', async () => {
    const { refresh, servers } = build();
    const server = servers[0] as Server;
    await refresh.scan();
    server.tasks = 'down';
    await refresh.scan();
    expect(await refresh.endpointFor('https://files.example.test/')).toBeDefined();
    server.tasks = [];
    await refresh.scan();
    expect(await refresh.endpointFor('https://files.example.test/')).toBeUndefined();
  });

  it('forgets the page once its download was handed over', async () => {
    const { refresh } = build();
    await refresh.scan();
    await refresh.done('https://files.example.test/setup');
    expect(await refresh.endpointFor('https://files.example.test/')).toBeUndefined();
  });
});
