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

/** The page to open again. Only an http(s) page, never the file address itself. */
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

/**
 * Notices whose task was not already shown. `seen` becomes the ids that are waiting now, so a task that leaves
 * `awaiting_link` and later comes back is shown again.
 */
export function freshNotices(
  notices: readonly RefreshNotice[],
  seen: readonly string[],
): { fresh: RefreshNotice[]; seen: string[] } {
  const known = new Set(seen);
  return {
    fresh: notices.filter((notice) => !known.has(notice.id)),
    seen: notices.map((notice) => notice.id),
  };
}
