import type { MediaKind } from './classify';

/** One row of a tab's media list. */
export interface MediaRow {
  url: string;
  kind: MediaKind;
  name: string;
  source: 'network' | 'page';
  mime?: string | undefined;
  sizeBytes?: number | undefined;
  /** Segment of this manifest: kept so later segments can be grouped, hidden from the list. */
  manifestUrl?: string | undefined;
}

export interface TabMedia {
  pageUrl: string;
  protectedMedia: boolean;
  blobOrMse: boolean;
  items: MediaRow[];
}

export const EMPTY_TAB: TabMedia = {
  pageUrl: '',
  protectedMedia: false,
  blobOrMse: false,
  items: [],
};

const MAX_ITEMS = 40;

/** The rows the popup shows: not the segments that belong to a manifest. */
export function visibleItems(tab: TabMedia): MediaRow[] {
  return tab.items.filter((item) => !item.manifestUrl);
}

/** Adds or refreshes one network row. A new page address drops the previous page's rows. */
export function addNetwork(tab: TabMedia, row: MediaRow, pageUrl: string): TabMedia {
  const base = tab.pageUrl === pageUrl ? tab : { ...EMPTY_TAB, pageUrl };
  return { ...base, items: upsert(base.items, row) };
}

/** Replaces the page-scan rows and keeps network rows for the same page. */
export function replacePage(
  tab: TabMedia,
  pageUrl: string,
  rows: readonly MediaRow[],
  flags: { protectedMedia: boolean; blobOrMse: boolean },
): TabMedia {
  const network =
    tab.pageUrl === pageUrl ? tab.items.filter((item) => item.source === 'network') : [];
  let items = [...network];
  for (const row of rows) items = upsert(items, row);
  return { pageUrl, ...flags, items };
}

function upsert(items: readonly MediaRow[], row: MediaRow): MediaRow[] {
  const without = items.filter((item) => item.url !== row.url);
  return [...without, row].slice(-MAX_ITEMS);
}

export function parseTab(raw: unknown): TabMedia {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_TAB, items: [] };
  const record = raw as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.flatMap(parseRow) : [];
  return {
    pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : '',
    protectedMedia: record.protectedMedia === true,
    blobOrMse: record.blobOrMse === true,
    items,
  };
}

function parseRow(raw: unknown): MediaRow[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const record = raw as Record<string, unknown>;
  if (typeof record.url !== 'string' || typeof record.name !== 'string') return [];
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
      ...(typeof record.manifestUrl === 'string' ? { manifestUrl: record.manifestUrl } : {}),
    },
  ];
}
