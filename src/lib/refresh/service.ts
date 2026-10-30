import type { ListTasksQuery } from '../api/client';
import { t } from '../i18n';
import type { NotificationsPort } from '../intercept/service';
import type { Logger } from '../log/log';
import type { SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { freshNotices, refreshNotices, type WaitingTask } from './watch';

const SEEN_KEY = 'refresh.seen';

/** Where a poll can ask for waiting tasks. */
export interface RefreshEndpoint {
  baseUrl: string;
  token: string;
}

export interface RefreshDeps {
  /** Every target this extension can currently call. */
  endpoints(): Promise<RefreshEndpoint[]>;
  settings: Pick<SettingsStore, 'get'>;
  notifications: NotificationsPort;
  /** Opens the stored page. `tabs.create` does not need the `tabs` permission. */
  open(url: string): Promise<void>;
  session: KeyValueArea;
  log: Logger;
  tasks: (
    baseUrl: string,
    token: string,
  ) => {
    listTasks(query?: ListTasksQuery): Promise<{ tasks: WaitingTask[] | null }>;
  };
  iconUrl?: string | undefined;
}

function parseSeen(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Polls for tasks whose link expired and the daemon is waiting for this browser to capture the download again.
 * Shown once per wait: a notification, and the stored page opened so the next matching download refreshes the task.
 */
export class RefreshService {
  constructor(private readonly deps: RefreshDeps) {}

  async scan(): Promise<void> {
    const notices = [];
    let endpoints: RefreshEndpoint[];
    try {
      endpoints = await this.deps.endpoints();
    } catch (error) {
      this.deps.log.debug('refresh', 'could not look up DLM', { error });
      return;
    }
    for (const endpoint of endpoints) {
      try {
        const list = await this.deps.tasks(endpoint.baseUrl, endpoint.token).listTasks({
          status: ['awaiting_link'],
        });
        notices.push(...refreshNotices(list.tasks ?? []));
      } catch (error) {
        this.deps.log.debug('refresh', 'could not list expired links', { error });
      }
    }
    const next = freshNotices(notices, parseSeen(await this.deps.session.get(SEEN_KEY)));
    await this.deps.session.set(SEEN_KEY, next.seen);
    if (next.fresh.length === 0) return;
    const notify = (await this.deps.settings.get()).preferences.notifications;
    const opened = new Set<string>();
    for (const notice of next.fresh) {
      if (notify) {
        try {
          await this.deps.notifications.create(`dlm-refresh-${notice.id}`, {
            title: notice.name,
            message: t('refresh.expired'),
            ...(this.deps.iconUrl ? { iconUrl: this.deps.iconUrl } : {}),
          });
        } catch (error) {
          this.deps.log.warn('refresh', 'could not notify', { error });
        }
      }
      if (!notice.pageUrl || opened.has(notice.pageUrl)) continue;
      opened.add(notice.pageUrl);
      try {
        await this.deps.open(notice.pageUrl);
      } catch (error) {
        this.deps.log.warn('refresh', 'could not open the page', { error });
      }
    }
  }
}
