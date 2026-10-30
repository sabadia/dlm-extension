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
