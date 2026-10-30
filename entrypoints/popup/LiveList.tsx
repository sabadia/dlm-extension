import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import { formatBytes, openInAppUrl, type LiveTask } from '../../src/lib/downloads/live';
import type { LiveSnapshot } from '../../src/lib/downloads/service';
import { t } from '../../src/lib/i18n';

/** The downloads DLM is working on. The stream lives only while this popup is open. */
export function LiveList() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({ tasks: [], queues: [], turbo: false });

  useEffect(() => {
    const port = browser.runtime.connect({ name: 'downloads' });
    const onMessage = (message: unknown) => {
      if (isSnapshot(message)) setSnapshot(message);
    };
    port.onMessage.addListener(onMessage);
    return () => port.disconnect();
  }, []);

  const refresh = () => {
    void sendMessage(browser.runtime, 'downloads.list').then(setSnapshot, () => undefined);
  };

  return (
    <section aria-labelledby="live-title">
      <h2 id="live-title">{t('live.title')}</h2>
      <label>
        <input
          type="checkbox"
          checked={snapshot.turbo}
          onChange={(event) => {
            void sendMessage(browser.runtime, 'downloads.turbo', {
              on: event.currentTarget.checked,
            }).then(refresh, () => undefined);
          }}
        />{' '}
        {t('live.turbo')} <span>{t('live.turboHelp')}</span>
      </label>
      {snapshot.tasks.length === 0 ? <p>{t('live.empty')}</p> : null}
      <ul>
        {snapshot.tasks.map((task) => (
          <TaskRow key={task.id} task={task} queues={snapshot.queues} onChanged={refresh} />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({
  task,
  queues,
  onChanged,
}: {
  task: LiveTask;
  queues: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const running = task.status === 'running';
  const fraction =
    task.size > 0 ? Math.min(100, Math.round((task.downloaded / task.size) * 100)) : 0;
  return (
    <li>
      <p>
        {task.name} · {task.status}
        {task.size > 0
          ? ` · ${formatBytes(task.downloaded)} / ${formatBytes(task.size)} (${fraction}%)`
          : ''}
        {task.speed > 0 ? ` · ${formatBytes(task.speed)}/s` : ''}
      </p>
      <button
        type="button"
        onClick={() => {
          void sendMessage(browser.runtime, running ? 'downloads.pause' : 'downloads.resume', {
            id: task.id,
          }).then(onChanged, () => undefined);
        }}
      >
        {running ? t('live.pause') : t('live.resume')}
      </button>{' '}
      {task.url ? <a href={openInAppUrl(task.url)}>{t('live.open')}</a> : null}{' '}
      <label>
        {t('live.queue')}{' '}
        <select
          value={task.queueId}
          onChange={(event) => {
            void sendMessage(browser.runtime, 'downloads.move', {
              id: task.id,
              queueId: event.currentTarget.value,
            }).then(onChanged, () => undefined);
          }}
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
