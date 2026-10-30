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
  it('follows the connection', () => {
    expect(setupSteps('host-not-installed').find((step) => step.id === 'host')?.done).toBe(false);
    expect(setupSteps('needs-pairing').find((step) => step.id === 'host')?.done).toBe(true);
    expect(setupSteps('needs-pairing').find((step) => step.id === 'pair')?.done).toBe(false);
    expect(setupSteps('connected').every((step) => step.done)).toBe(true);
  });
});
