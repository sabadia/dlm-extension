import type { MediaKind } from './classify';

/** One row of a tab's media list. */
export interface MediaRow {
  url: string;
  kind: MediaKind;
  name: string;
  source: 'network' | 'page';
  mime?: string | undefined;
  sizeBytes?: number | undefined;
}

export interface TabMedia {
  pageUrl: string;
  /** The title of the page, for naming its files. */
  title: string;
  protectedMedia: boolean;
  blobOrMse: boolean;
  items: MediaRow[];
  /** When the tab's list last changed (milliseconds): the tab that was not touched longest is dropped first. */
  at: number;
}

export function emptyTab(pageUrl = '', at = 0): TabMedia {
  return { pageUrl, title: '', protectedMedia: false, blobOrMse: false, items: [], at };
}

/** The most rows of one tab, and the most tabs, that are kept. */
export const MAX_ITEMS = 40;
export const MAX_TABS = 30;

/** The key in `storage.session` that holds every tab's list. */
export const MEDIA_TABS_KEY = 'media.tabs';

/** Adds or refreshes one network row. */
export function addNetwork(tab: TabMedia, row: MediaRow, now: number): TabMedia {
  return { ...tab, items: upsert(tab.items, row), at: now };
}

/** Replaces the page-scan rows and keeps the network rows. */
export function replacePage(
  tab: TabMedia,
  pageUrl: string,
  rows: readonly MediaRow[],
  flags: { protectedMedia: boolean; blobOrMse: boolean; title?: string },
  now: number,
): TabMedia {
  let items = tab.items.filter((item) => item.source === 'network');
  for (const row of rows) items = upsert(items, row);
  return {
    pageUrl,
    title: flags.title ?? tab.title,
    // Once protected media was seen on the page, it stays so (an iframe may have said it).
    protectedMedia: flags.protectedMedia || tab.protectedMedia,
    blobOrMse: flags.blobOrMse,
    items,
    at: now,
  };
}

function upsert(items: readonly MediaRow[], row: MediaRow): MediaRow[] {
  const without = items.filter((item) => item.url !== row.url);
  return [...without, row].slice(-MAX_ITEMS);
}

/** The tabs to keep: the `MAX_TABS` most recently changed. */
export function limitTabs(all: Record<string, TabMedia>): Record<string, TabMedia> {
  const entries = Object.entries(all);
  if (entries.length <= MAX_TABS) return all;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_TABS));
}

export function parseTab(raw: unknown): TabMedia {
  if (typeof raw !== 'object' || raw === null) return emptyTab();
  const record = raw as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.flatMap(parseRow) : [];
  return {
    pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : '',
    title: typeof record.title === 'string' ? record.title : '',
    protectedMedia: record.protectedMedia === true,
    blobOrMse: record.blobOrMse === true,
    items,
    at: typeof record.at === 'number' ? record.at : 0,
  };
}

export function parseTabs(raw: unknown): Record<string, TabMedia> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, TabMedia> = {};
  for (const [id, value] of Object.entries(raw)) out[id] = parseTab(value);
  return out;
}

/** How many rows each tab shows, by tab id. Used to paint the toolbar button of every tab. */
export function tabCounts(raw: unknown): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [id, tab] of Object.entries(parseTabs(raw))) {
    const tabId = Number(id);
    if (Number.isInteger(tabId)) counts.set(tabId, tab.items.length);
  }
  return counts;
}

function parseRow(raw: unknown): MediaRow[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const record = raw as Record<string, unknown>;
  if (typeof record.url !== 'string' || typeof record.name !== 'string') return [];
  // Rows of an older shape that stood for a segment of a manifest are dropped.
  if (record.manifestUrl !== undefined) return [];
  const kind = record.kind;
  if (kind !== 'hls' && kind !== 'dash' && kind !== 'video' && kind !== 'audio' && kind !== 'file')
    return [];
  if (record.source !== 'network' && record.source !== 'page') return [];
  return [
    {
      url: record.url,
      kind,
      name: record.name,
      source: record.source,
      ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
    },
  ];
}
