import { fileExtension } from '../intercept/rules';

/** A magnet link. The browser would otherwise ask to open an external app. */
export function isMagnet(url: string): boolean {
  return url.trim().toLowerCase().startsWith('magnet:');
}

/** An eD2K link. Same treatment as a magnet link. */
export function isEd2k(url: string): boolean {
  return url.trim().toLowerCase().startsWith('ed2k:');
}

/** A link the extension sends itself, so the browser never prompts to open another app. */
export function isDirectScheme(url: string): boolean {
  return isMagnet(url) || isEd2k(url);
}

const TORRENT_MIMES = new Set(['application/x-bittorrent', 'application/x-torrent']);

/** A `.torrent` file, by its extension or content type. */
export function isTorrent(facts: { url?: string; filename?: string; mime?: string }): boolean {
  const url = facts.url ?? '';
  if (fileExtension(facts.filename, url) === 'torrent') return true;
  const mime = facts.mime?.split(';')[0]?.trim().toLowerCase();
  return mime !== undefined && TORRENT_MIMES.has(mime);
}
