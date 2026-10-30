import type { ConnectionState } from '../../lib/connection/state';
import type { ProbeResult } from '../../lib/files/probe';
import type { Variant } from '../../lib/media/playlist';
import type { CookiesRequest, DownloadRequest, TabView } from '../../lib/media/service';
import type { FilesPrefs, Settings } from '../../lib/settings/schema';

/** The tab the panel is about. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  incognito: boolean;
  cookieStoreId?: string | undefined;
}

export type CookieSendResult =
  | { ok: true; host: string; imported: number; skipped: number; rejected: number }
  | { ok: false; error: string };

/**
 * Everything the Files view needs from the browser and the background. The real one is in `browser-api.ts`; tests give
 * the view a fake, so the whole view can be tried without a browser.
 */
export interface FilesApi {
  activeTab(): Promise<TabInfo | undefined>;
  /** Calls `listener` when the active tab or its page changes. Returns the way to stop. */
  subscribe(listener: () => void): () => void;
  mediaList(tabId: number): Promise<TabView>;
  /** Checks an address (cached for ten minutes unless `force`). */
  probe(url: string, force?: boolean): Promise<ProbeResult>;
  settings(): Promise<Settings>;
  saveFiles(files: FilesPrefs): Promise<Settings>;
  connection(): Promise<{ kind: ConnectionState['kind']; text: string }>;
  queues(): Promise<{ id: string; name: string }[]>;
  download(request: DownloadRequest): Promise<{ ok: boolean; error?: string }>;
  variants(url: string): Promise<Variant[]>;
  cookiesPreview(request: CookiesRequest): Promise<{ host: string; count: number }>;
  sendCookies(request: CookiesRequest): Promise<CookieSendResult>;
  openSetup(): void;
  openSettings(): void;
  openPage(url: string): void;
  copy(text: string): Promise<void>;
}
