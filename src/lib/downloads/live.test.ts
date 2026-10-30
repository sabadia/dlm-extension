import { describe, expect, it } from 'vitest';
import { applyLiveEvent, formatBytes, liveFromTask, openInAppUrl } from './live';
import { setupSteps } from './setup';

describe('live events', () => {
  const task = liveFromTask({
    id: 'a',
    name: 'a.bin',
    status: 'queued',
    downloaded: 0,
    size: 100,
    queueId: 'main',
    source: { currentUrl: 'https://example.test/a.bin' },
  });

  it('updates progress, status and membership', () => {
    const progress = applyLiveEvent([task], {
      event: 'task.progress',
      data: JSON.stringify({
        type: 'task.progress',
        taskId: 'a',
        data: { downloaded: 40, size: 100, speed: 10 },
      }),
    });
    expect(progress.tasks[0]).toMatchObject({ downloaded: 40, speed: 10, status: 'running' });
    const paused = applyLiveEvent(progress.tasks, {
      event: 'task.status',
      data: JSON.stringify({
        type: 'task.status',
        taskId: 'a',
        data: { from: 'running', to: 'paused' },
      }),
    });
    expect(paused.tasks[0]?.status).toBe('paused');
    const gone = applyLiveEvent(paused.tasks, {
      event: 'task.deleted',
      data: JSON.stringify({ type: 'task.deleted', taskId: 'a' }),
    });
    expect(gone.tasks).toEqual([]);
    expect(applyLiveEvent([task], { event: 'reset', data: '' }).reset).toBe(true);
  });

  it('formats sizes and the app link', () => {
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(openInAppUrl('https://example.test/a.bin')).toBe(
      'dlm://add?url=https%3A%2F%2Fexample.test%2Fa.bin',
    );
  });
});

describe('setup steps', () => {
  const done = (kind: Parameters<typeof setupSteps>[0], access = true) =>
    setupSteps(kind, access)
      .map((step) => `${step.id}:${step.done ? 'x' : '-'}`)
      .join(' ');

  it.each([
    ['checking', 'app:- host:- pair:- access:x test:-'],
    ['host-not-installed', 'app:x host:- pair:- access:x test:-'],
    ['app-not-running', 'app:- host:- pair:- access:x test:-'],
    ['needs-pairing', 'app:x host:x pair:- access:x test:-'],
    ['pairing', 'app:x host:x pair:- access:x test:-'],
    ['token-revoked', 'app:x host:x pair:- access:x test:-'],
    ['access-needed', 'app:x host:x pair:- access:- test:-'],
    ['local-unreachable', 'app:x host:x pair:x access:x test:-'],
    ['connected', 'app:x host:x pair:x access:x test:x'],
    // A server added by URL needs no host and no pairing.
    ['remote-needs-token', 'app:x host:x pair:x access:x test:-'],
    ['remote-unreachable', 'app:x host:x pair:x access:x test:-'],
  ] as const)('%s: %s', (kind, expected) => {
    expect(done(kind)).toBe(expected);
  });

  it('wants the permission for every site, which Firefox grants only when asked', () => {
    expect(done('connected', false)).toBe('app:x host:x pair:x access:- test:x');
  });
});

describe('what a task can be told to do', () => {
  it('offers pause and resume only where the daemon accepts them', async () => {
    const { canPause, canResume } = await import('./live');
    expect(['running', 'queued', 'awaiting_link'].every(canPause)).toBe(true);
    expect(['paused', 'completed', 'error'].some(canPause)).toBe(false);
    expect(['paused', 'error'].every(canResume)).toBe(true);
    expect(['running', 'completed', 'queued'].some(canResume)).toBe(false);
  });
});
