import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import {
  canPause,
  canResume,
  formatBytes,
  OPEN_APP_URL,
  type LiveTask,
} from '../../src/lib/downloads/live';
import type { LiveSnapshot } from '../../src/lib/downloads/service';
import { statusText, t } from '../../src/lib/i18n';

const EMPTY: LiveSnapshot = { tasks: [], queues: [], turbo: false, reachable: true };

/** The text of a failed action. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : t('error.failed');

/**
 * The downloads DLM is working on. The stream runs in the background only while this popup is open; when the
 * connection to the background drops (the worker was stopped), the popup connects again.
 */
export function LiveList() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(EMPTY);
  const [note, setNote] = useState('');

  useEffect(() => {
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let delay = 500;
    const connect = () => {
      if (closed) return;
      port = browser.runtime.connect({ name: 'downloads' });
      port.onMessage.addListener((message: unknown) => {
        delay = 500;
        if (isSnapshot(message)) setSnapshot(message);
      });
      port.onDisconnect.addListener(() => {
        port = undefined;
        if (closed) return;
        setSnapshot((current) => ({ ...current, reachable: false }));
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      });
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      port?.disconnect();
    };
  }, []);

  const refresh = () => {
    void sendMessage(browser.runtime, 'downloads.list').then(setSnapshot, (e: unknown) =>
      setNote(errorText(e)),
    );
  };

  /** Runs an action and shows what went wrong, if anything. */
  const act = (run: Promise<unknown>) => {
    setNote('');
    run.then(refresh, (e: unknown) => {
      setNote(errorText(e));
      // A checkbox that was flipped by the click goes back to what DLM says.
      setSnapshot((current) => ({ ...current }));
    });
  };

  return (
    <section aria-labelledby="live-title">
      <h2 id="live-title">{t('live.title')}</h2>
      {snapshot.reachable ? null : <p role="status">{t('live.reconnecting')}</p>}
      <label>
        <input
          type="checkbox"
          checked={snapshot.turbo}
          aria-describedby="live-turbo-help"
          onChange={(event) =>
            act(
              sendMessage(browser.runtime, 'downloads.turbo', {
                on: event.currentTarget.checked,
              }),
            )
          }
        />{' '}
        {t('live.turbo')} <span id="live-turbo-help">{t('live.turboHelp')}</span>
      </label>{' '}
      <a href={OPEN_APP_URL}>{t('live.open')}</a>
      <p role="alert">{note}</p>
      {snapshot.tasks.length === 0 ? <p>{t('live.empty')}</p> : null}
      <ul>
        {snapshot.tasks.map((task) => (
          <TaskRow key={task.id} task={task} queues={snapshot.queues} act={act} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({
  task,
  queues,
  act,
}: {
  task: LiveTask;
  queues: { id: string; name: string }[];
  act: (run: Promise<unknown>) => void;
}) {
  const fraction =
    task.size > 0 ? Math.min(100, Math.round((task.downloaded / task.size) * 100)) : 0;
  return (
    <li>
      <p>
        {task.name} · {statusText(task.status)}
        {task.size > 0
          ? ` · ${formatBytes(task.downloaded)} / ${formatBytes(task.size)} (${fraction}%)`
          : ''}
        {task.speed > 0 ? ` · ${formatBytes(task.speed)}/s` : ''}
      </p>
      {task.size > 0 ? (
        <progress value={task.downloaded} max={task.size} aria-label={task.name} />
      ) : null}
      {canPause(task.status) ? (
        <button
          type="button"
          onClick={() => act(sendMessage(browser.runtime, 'downloads.pause', { id: task.id }))}
        >
          {t('live.pause')}
        </button>
      ) : null}
      {canResume(task.status) ? (
        <button
          type="button"
          onClick={() => act(sendMessage(browser.runtime, 'downloads.resume', { id: task.id }))}
        >
          {t('live.resume')}
        </button>
      ) : null}{' '}
      <label>
        {t('live.queue')}{' '}
        <select
          value={task.queueId}
          onChange={(event) =>
            act(
              sendMessage(browser.runtime, 'downloads.move', {
                id: task.id,
                queueId: event.currentTarget.value,
              }),
            )
          }
        >
          {queues.map((queue) => (
            <option key={queue.id} value={queue.id}>
              {queue.name}
            </option>
          ))}
        </select>
      </label>
    </li>
  );
}

function isSnapshot(value: unknown): value is LiveSnapshot {
  return (
    typeof value === 'object' && value !== null && 'tasks' in value && Array.isArray(value.tasks)
  );
}
