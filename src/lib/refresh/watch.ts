import { t } from '../i18n';
/**
 * Which expired links the extension should tell the user about. The daemon keeps a task in `awaiting_link` until the
 * next matching download is captured (docs/PLAN.md, E6.1). The worker does not stay awake for a stream (spike E0.8),
 * so this is a short poll.
 */

/** An alarm of half a minute. Chrome's shortest repeating alarm is 30 seconds. */
export const REFRESH_PERIOD_MINUTES = 0.5;

export interface WaitingTask {
  id: string;
  status: string;
  name?: string | undefined;
  source?:
    | {
        pageUrl?: string | undefined;
        originalUrl?: string | undefined;
      }
    | undefined;
}

/** One task the user should see again: its page, when we know one. */
export interface RefreshNotice {
  id: string;
  name: string;
  pageUrl?: string | undefined;
}

/** A notice that belongs to one server: task ids are only unique per server. */
export interface ServerNotice extends RefreshNotice {
  /** The server's address. */
  server: string;
}

/** `server` and task id as one key. */
export const noticeKey = (notice: Pick<ServerNotice, 'server' | 'id'>): string =>
  `${notice.server}\n${notice.id}`;

/**
 * The page to open again: the page the download started from, else the link that was clicked (opening it starts the
 * download again, and the hand-off captures it). Only an http(s) address is ever opened.
 */
export function storedPage(source: WaitingTask['source']): string | undefined {
  for (const url of [source?.pageUrl, source?.originalUrl]) {
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

/** Tasks that are waiting for a new link, in the order the daemon listed them. */
export function refreshNotices(tasks: readonly WaitingTask[]): RefreshNotice[] {
  const notices: RefreshNotice[] = [];
  for (const task of tasks) {
    if (task.status !== 'awaiting_link' || task.id === '') continue;
    const pageUrl = storedPage(task.source);
    const name = task.name?.trim() || t('downloads.unnamed');
    notices.push(pageUrl ? { id: task.id, name, pageUrl } : { id: task.id, name });
  }
  return notices;
}

/** A notice that was shown, and when. It is forgotten after {@link SEEN_TTL_MS}, so a task still waiting a week later is told again. */
export interface SeenNotice {
  key: string;
  at: number;
}

export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which notices are new, and what has been shown after this scan. A task that stopped waiting on a server that
 * answered is forgotten (it may come back and is then new); everything about a server that did not answer is kept, so a
 * server that fails once is not told about again when it recovers.
 */
export function freshNotices(
  notices: readonly ServerNotice[],
  seen: readonly SeenNotice[],
  answered: ReadonlySet<string>,
  now: number,
): { fresh: ServerNotice[]; seen: SeenNotice[] } {
  const live = seen.filter((entry) => now - entry.at <= SEEN_TTL_MS);
  const known = new Map(live.map((entry) => [entry.key, entry]));
  const waiting = new Set(notices.map(noticeKey));
  const kept = live.filter((entry) => {
    const server = entry.key.split('\n')[0] ?? '';
    return !answered.has(server) || waiting.has(entry.key);
  });
  const fresh = notices.filter((notice) => !known.has(noticeKey(notice)));
  return {
    fresh,
    seen: [...kept, ...fresh.map((notice) => ({ key: noticeKey(notice), at: now }))],
  };
}
