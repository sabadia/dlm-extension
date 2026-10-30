import type { ListTasksQuery } from '../api/client';
import { t } from '../i18n';
import { downloadHost, hostCoveredBy } from '../intercept/rules';
import type { NotificationsPort } from '../intercept/service';
import type { Logger } from '../log/log';
import type { SettingsStore } from '../settings/store';
import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import {
  freshNotices,
  noticeKey,
  refreshNotices,
  type SeenNotice,
  type ServerNotice,
  type WaitingTask,
} from './watch';

const SEEN_KEY = 'refresh.seen';
const PAGES_KEY = 'refresh.pages';
const PENDING_KEY = 'refresh.pending';

/** Notification ids of an expired link start with this; the click handler knows them by it. */
export const REFRESH_PREFIX = 'dlm-refresh:';

/** How long the extension keeps looking for the download that renews a task, after the last time it was seen waiting. */
const PENDING_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 50;
const MAX_PENDING = 20;

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
  /** Opens a page in a new tab. `tabs.create` does not need the `tabs` permission. */
  open(url: string): Promise<void>;
  /** `storage.local`: which notices were shown, for a week. */
  local: KeyValueArea;
  /** `storage.session`: which page a notification opens, and which pages are waiting for their download. */
  session: KeyValueArea;
  log: Logger;
  tasks: (
    baseUrl: string,
    token: string,
  ) => {
    listTasks(query?: ListTasksQuery): Promise<{ tasks: WaitingTask[] | null }>;
  };
  iconUrl?: string | undefined;
  now?: () => number;
}

/** A page whose next matching download renews the expired task of a server. */
interface Pending {
  host: string;
  server: string;
  at: number;
}

function parseSeen(raw: unknown): SeenNotice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { key, at } = item as { key?: unknown; at?: unknown };
    return typeof key === 'string' && typeof at === 'number' ? [{ key, at }] : [];
  });
}

function parsePages(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function parsePending(raw: unknown): Pending[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { host, server, at } = item as { host?: unknown; server?: unknown; at?: unknown };
    return typeof host === 'string' && typeof server === 'string' && typeof at === 'number'
      ? [{ host, server, at }]
      : [];
  });
}

/** A short stable id for a string (a notification id must not carry a whole address). */
function hashOf(text: string): string {
  let hash = 5381;
  for (const char of text) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

/** The address if it is one a person may be sent to: http or https only. */
function webPage(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks for tasks whose link expired and that the daemon is waiting for this browser to capture again. Each is shown
 * once as a notification; clicking it opens the stored page (nothing opens by itself). The page is remembered, so the
 * next download that starts there is handed to the server that is waiting, whatever the rules say.
 */
export class RefreshService {
  private readonly seen: StoredValue<SeenNotice[]>;
  private readonly pages: StoredValue<Record<string, string>>;
  private readonly pending: StoredValue<Pending[]>;
  private readonly now: () => number;

  constructor(private readonly deps: RefreshDeps) {
    this.seen = new StoredValue(deps.local, SEEN_KEY, parseSeen);
    this.pages = new StoredValue(deps.session, PAGES_KEY, parsePages);
    this.pending = new StoredValue(deps.session, PENDING_KEY, parsePending);
    this.now = deps.now ?? (() => Date.now());
  }

  async scan(): Promise<void> {
    const settings = await this.deps.settings.get();
    if (!settings.preferences.refresh) return;
    let endpoints: RefreshEndpoint[];
    try {
      endpoints = await this.deps.endpoints();
    } catch (error) {
      this.deps.log.debug('refresh', 'could not look up DLM', { error });
      return;
    }
    const notices: ServerNotice[] = [];
    const answered = new Set<string>();
    const tokens = new Map<string, string>();
    for (const endpoint of endpoints) {
      try {
        const list = await this.deps.tasks(endpoint.baseUrl, endpoint.token).listTasks({
          status: ['awaiting_link'],
        });
        answered.add(endpoint.baseUrl);
        tokens.set(endpoint.baseUrl, endpoint.token);
        notices.push(
          ...refreshNotices(list.tasks ?? []).map((notice) => ({
            ...notice,
            server: endpoint.baseUrl,
          })),
        );
      } catch (error) {
        this.deps.log.debug('refresh', 'could not list expired links', { error });
      }
    }
    const now = this.now();
    let fresh: ServerNotice[] = [];
    await this.seen.update((list) => {
      const next = freshNotices(notices, list, answered, now);
      fresh = next.fresh;
      return next.seen;
    });
    await this.remember(notices, now);
    if (fresh.length === 0 || !settings.preferences.notifications) return;
    for (const notice of fresh) await this.notify(notice);
  }

  /**
   * The server that is waiting for a download from `pageUrl`, when one is: the hand-off sends that download there, and
   * takes it even when the rules would leave it in the browser (the person is renewing a task).
   */
  async endpointFor(pageUrl: string | undefined): Promise<RefreshEndpoint | undefined> {
    const host = pageUrl ? downloadHost(pageUrl) : undefined;
    if (!host) return undefined;
    const now = this.now();
    const waiting = (await this.pending.get()).find(
      (item) => now - item.at <= PENDING_TTL_MS && hostCoveredBy(host, item.host),
    );
    if (!waiting) return undefined;
    try {
      return (await this.deps.endpoints()).find((endpoint) => endpoint.baseUrl === waiting.server);
    } catch {
      return undefined;
    }
  }

  /** The person clicked a notification of an expired link: open its page. Returns true when the click was ours. */
  async onNotificationClicked(notificationId: string): Promise<boolean> {
    if (!notificationId.startsWith(REFRESH_PREFIX)) return false;
    let page: string | undefined;
    await this.pages.update((map) => {
      page = map[notificationId];
      const next = { ...map };
      delete next[notificationId];
      return next;
    });
    const safe = page ? webPage(page) : undefined;
    if (!safe) return true;
    try {
      await this.deps.open(safe);
    } catch (error) {
      this.deps.log.warn('refresh', 'could not open the page', { error });
    }
    return true;
  }

  private async notify(notice: ServerNotice): Promise<void> {
    const id = `${REFRESH_PREFIX}${hashOf(noticeKey(notice))}`;
    const page = notice.pageUrl ? webPage(notice.pageUrl) : undefined;
    if (page) {
      await this.pages.update((map) => {
        const entries = Object.entries({ ...map, [id]: page });
        return Object.fromEntries(entries.slice(-MAX_PAGES));
      });
    }
    try {
      await this.deps.notifications.create(id, {
        title: notice.name,
        message: page ? t('refresh.expired') : t('refresh.expiredNoPage'),
        ...(this.deps.iconUrl ? { iconUrl: this.deps.iconUrl } : {}),
      });
    } catch (error) {
      this.deps.log.warn('refresh', 'could not notify', { error });
    }
  }

  /** The pages that are waiting for a download, with the time they were last seen waiting. */
  private async remember(notices: readonly ServerNotice[], now: number): Promise<void> {
    const waiting = notices.flatMap((notice) => {
      const host = notice.pageUrl ? downloadHost(notice.pageUrl) : undefined;
      return host ? [{ host, server: notice.server, at: now }] : [];
    });
    await this.pending.update((list) => {
      const kept = list.filter(
        (item) =>
          now - item.at <= PENDING_TTL_MS &&
          !waiting.some((w) => w.host === item.host && w.server === item.server),
      );
      return [...kept, ...waiting].slice(-MAX_PENDING);
    });
  }
}
