import type { MediaView } from '../media/service';
import type { FileSort } from '../settings/schema';
import { fileKindOf, type FileKind } from './kinds';
import { extensionOf, nameFromLink } from './naming';
import type { ProbeResult } from './probe';

/** One file of the page, as the panel lists it. */
export interface FileEntry {
  /** The address the page offers. It is the identity of the row. */
  id: string;
  url: string;
  /** The address after redirects; the address itself when nothing redirected or redirects are not followed. */
  finalUrl: string;
  host: string;
  kind: FileKind;
  ext: string | undefined;
  mime: string | undefined;
  sizeBytes: number | undefined;
  /** HLS or DASH: a stream is sized by its parts, which the page does not know. */
  stream: 'hls' | 'dash' | undefined;
  /** The name the server gave. */
  serverName: string | undefined;
}

export type ProbeState = 'pending' | 'valid' | 'invalid';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The entry for a row of the tab's media list and what the check found out about it. Network rows already carry the
 * size of the response, so they need no check; a row that is checked is valid only with a positive result.
 */
export function entryFor(
  row: MediaView,
  probe: ProbeResult | undefined,
  followRedirects: boolean,
): { entry: FileEntry; state: ProbeState } {
  const stream = row.kind === 'hls' || row.kind === 'dash' ? row.kind : undefined;
  const known = row.sizeBytes !== undefined && row.sizeBytes > 0 ? row.sizeBytes : undefined;
  const checked = probe?.ok ? probe : undefined;
  const sizeBytes = checked?.sizeBytes ?? known;
  const finalUrl = followRedirects && checked?.finalUrl ? checked.finalUrl : row.url;
  const mime = checked?.mime ?? row.mime;
  const serverName = checked?.serverName;
  const ext = extensionOf(serverName) ?? extensionOf(finalUrl) ?? extensionOf(row.url);
  const entry: FileEntry = {
    id: row.url,
    url: row.url,
    finalUrl,
    host: hostOf(finalUrl),
    kind: stream ? 'stream' : fileKindOf({ ext, mime }),
    ext,
    mime,
    sizeBytes,
    stream,
    serverName,
  };
  // A stream has no size and is not checked: the page or the network offered it as media. Any other file is valid once
  // its size is known, from the network or from a check; a check that failed makes it invalid.
  const state: ProbeState = stream
    ? 'valid'
    : sizeBytes !== undefined
      ? 'valid'
      : probe
        ? 'invalid'
        : 'pending';
  return { entry, state };
}

/** A file is worth checking when it is not a stream, has no size from the network and has not been checked. */
export function needsCheck(row: MediaView, probe: ProbeResult | undefined): boolean {
  if (probe || row.kind === 'hls' || row.kind === 'dash') return false;
  return !(row.sizeBytes !== undefined && row.sizeBytes > 0);
}

/** What naming needs to know about an entry. */
export function nameFacts(entry: FileEntry) {
  return {
    id: entry.id,
    url: entry.finalUrl,
    serverName: entry.serverName,
    mime: entry.mime,
    stream: entry.stream !== undefined,
  };
}

export interface View {
  query: string;
  kind: FileKind | 'all';
  sort: FileSort;
}

/** Search, type filter and sort. Streams come after the sized files when sorting by size. */
export function applyView(
  entries: readonly FileEntry[],
  names: ReadonlyMap<string, string>,
  view: View,
): FileEntry[] {
  const query = view.query.trim().toLowerCase();
  const nameOf = (entry: FileEntry) => names.get(entry.id) ?? nameFromLink(nameFacts(entry));
  const shown = entries.filter((entry) => {
    if (view.kind !== 'all' && entry.kind !== view.kind) return false;
    if (query === '') return true;
    return `${nameOf(entry)} ${entry.host} ${entry.ext ?? ''}`.toLowerCase().includes(query);
  });
  const bySize = (a: FileEntry, b: FileEntry) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1);
  const byName = (a: FileEntry, b: FileEntry) =>
    nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' });
  const sorted = [...shown];
  switch (view.sort) {
    case 'size-desc':
      sorted.sort((a, b) => bySize(a, b) || byName(a, b));
      break;
    case 'size-asc':
      sorted.sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || byName(a, b));
      break;
    case 'name':
      sorted.sort(byName);
      break;
    case 'type':
      sorted.sort((a, b) => a.kind.localeCompare(b.kind) || bySize(a, b));
      break;
  }
  return sorted;
}

/** How many entries each kind has, for the chips. */
export function countKinds(entries: readonly FileEntry[]): Map<FileKind, number> {
  const counts = new Map<FileKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return counts;
}

/** `1.4 GB`, `820 KB`: decimal units, as the DLM app shows them. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'TB'}`;
}
