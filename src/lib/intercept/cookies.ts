import type { CaptureCookie } from '../api/client';
import type { Logger } from '../log/log';
import { toCaptureCookie, type BrowserCookieLike } from './metadata';

export interface CookieQuery {
  url: string;
  storeId?: string | undefined;
  partitionKey?: { topLevelSite: string } | undefined;
}

export interface CookiesPort {
  getAll(query: CookieQuery): Promise<BrowserCookieLike[]>;
  /** Chrome: the cookie stores and the tabs in each, to find the private window's store. Absent on Firefox. */
  stores?(): Promise<{ id: string; tabIds: number[] }[]>;
}

/** What the daemon accepts in one capture from an extension token; a larger one is refused whole (422). */
export const MAX_CAPTURE_COOKIES = 200;
export const MAX_COOKIE_BYTES = 8 * 1024;
export const MAX_COOKIES_TOTAL = 256 * 1024;

/**
 * Cuts the cookies of a capture down to what the daemon takes: none over 8 KiB, at most 200, 256 KiB together. The
 * most specific ones stay (a longer path, then a longer domain), because those are the ones that match fewer requests
 * and so are the ones the download needs.
 */
export function fitCaptureLimits(cookies: readonly CaptureCookie[]): CaptureCookie[] {
  const size = (cookie: CaptureCookie) => cookie.name.length + cookie.value.length;
  const ranked = cookies
    .filter((cookie) => size(cookie) <= MAX_COOKIE_BYTES)
    .map((cookie, index) => ({ cookie, index }))
    .sort(
      (a, b) =>
        (b.cookie.path?.length ?? 0) - (a.cookie.path?.length ?? 0) ||
        b.cookie.domain.length - a.cookie.domain.length ||
        a.index - b.index,
    );
  const kept: typeof ranked = [];
  let total = 0;
  for (const entry of ranked) {
    const bytes =
      size(entry.cookie) + entry.cookie.domain.length + (entry.cookie.path?.length ?? 0);
    if (kept.length >= MAX_CAPTURE_COOKIES || total + bytes > MAX_COOKIES_TOTAL) continue;
    total += bytes;
    kept.push(entry);
  }
  return kept.sort((a, b) => a.index - b.index).map((entry) => entry.cookie);
}

export interface CookieRequest {
  /** The address the cookies are for (the download itself). */
  url: string;
  /** The page it started on: Chrome's partitioned (CHIPS) cookies are keyed by its site. */
  pageUrl?: string | undefined;
  /** Firefox: the container or private store the request used. */
  storeId?: string | undefined;
  /** Chrome: the tab, to find its cookie store (a private window has one of its own). */
  tabId?: number | undefined;
  incognito: boolean;
  /** The person allowed downloads from private windows. */
  allowPrivate: boolean;
  /** The download's own host: no cookie of another domain is ever returned. */
  host: string;
}

/**
 * Reads the cookies a download needs: those for its own domain, from the cookie store of the tab it started in, never
 * from a private window unless the person allowed it (docs/CONVENTIONS.md, "Least data").
 */
export class CookieReader {
  constructor(
    private readonly cookies: CookiesPort,
    private readonly log: Logger,
  ) {}

  async read(request: CookieRequest): Promise<CaptureCookie[]> {
    if (request.incognito && !request.allowPrivate) return [];
    const store = request.storeId ?? (await this.storeOfTab(request.tabId));
    const base: CookieQuery = store ? { url: request.url, storeId: store } : { url: request.url };
    const lists: BrowserCookieLike[][] = [await this.list(base)];
    if (request.pageUrl) {
      try {
        const origin = new URL(request.pageUrl).origin;
        if (origin !== 'null') {
          lists.push(await this.list({ ...base, partitionKey: { topLevelSite: origin } }));
        }
      } catch {
        // The page address is not a URL we can use as a partition key.
      }
    }
    const seen = new Set<string>();
    const cookies: CaptureCookie[] = [];
    for (const cookie of lists.flat()) {
      const mapped = toCaptureCookie(cookie, request.host);
      if (!mapped) continue;
      const key = `${mapped.domain}\n${mapped.name}\n${mapped.path ?? ''}\n${mapped.partitionKey ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(mapped);
    }
    return cookies;
  }

  /** Chrome: webRequest has no cookie store, but the stores know their tabs. */
  private async storeOfTab(tabId: number | undefined): Promise<string | undefined> {
    if (tabId === undefined || tabId < 0 || !this.cookies.stores) return undefined;
    try {
      const stores = await this.cookies.stores();
      return stores.find((store) => store.tabIds.includes(tabId))?.id;
    } catch (error) {
      this.log.debug('cookies', 'cookie stores could not be listed', { error });
      return undefined;
    }
  }

  private async list(query: CookieQuery): Promise<BrowserCookieLike[]> {
    try {
      return await this.cookies.getAll(query);
    } catch (error) {
      this.log.debug('cookies', 'cookies could not be read', { error });
      return [];
    }
  }
}
