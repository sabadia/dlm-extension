import { describe, expect, it } from 'vitest';
import { silentLog } from '../log/log';
import { defaultSettings, type Settings } from '../settings/schema';
import { memoryArea } from '../storage/area';
import { RefreshService } from './service';
import type { WaitingTask } from './watch';

const task = {
  id: 't1',
  status: 'awaiting_link',
  name: 'Setup',
  source: { pageUrl: 'https://files.example.test/setup' },
};

function service(over: { notifications?: boolean; tasks?: WaitingTask[] | null } = {}) {
  const opened: string[] = [];
  const notes: { title: string; message: string }[] = [];
  const settings: Settings = {
    ...defaultSettings(),
    preferences: {
      ...defaultSettings().preferences,
      notifications: over.notifications ?? true,
    },
  };
  const refresh = new RefreshService({
    endpoints: () => Promise.resolve([{ baseUrl: 'http://127.0.0.1:1', token: 't' }]),
    settings: { get: () => Promise.resolve(settings) },
    notifications: {
      create: (_id, options) => {
        notes.push({ title: options.title, message: options.message });
      },
    },
    open: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    session: memoryArea(),
    log: silentLog,
    tasks: () => ({
      listTasks: () => Promise.resolve({ tasks: over.tasks === undefined ? [task] : over.tasks }),
    }),
  });
  return { refresh, opened, notes };
}

describe('RefreshService', () => {
  it('notifies and opens the stored page once', async () => {
    const { refresh, opened, notes } = service();
    await refresh.scan();
    await refresh.scan();
    expect(notes).toEqual([{ title: 'Setup', message: 'Link expired: open the page' }]);
    expect(opened).toEqual(['https://files.example.test/setup']);
  });

  it('still opens the page when notifications are off', async () => {
    const { refresh, opened, notes } = service({ notifications: false });
    await refresh.scan();
    expect(notes).toEqual([]);
    expect(opened).toEqual(['https://files.example.test/setup']);
  });
});
