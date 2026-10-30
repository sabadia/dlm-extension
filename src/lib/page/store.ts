import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { acceptedHints, hintFor, rememberPageHints, type PageHint, type StoredHint } from './hints';

function parseHints(raw: unknown): StoredHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: StoredHint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const at = (item as { at?: unknown }).at;
    if (typeof at !== 'number') continue;
    const [hint] = acceptedHints([item]);
    if (hint) hints.push({ ...hint, at });
  }
  return hints;
}

/** Checksums and mirror links reported by pages, kept in `storage.session` so a restarted worker still has them. */
export class HintStore {
  private readonly stored: StoredValue<StoredHint[]>;

  constructor(area: KeyValueArea) {
    this.stored = new StoredValue(area, 'page.hints', parseHints);
  }

  note(hints: readonly PageHint[], now = Date.now()): Promise<void> {
    return this.stored.update((list) => rememberPageHints(list, hints, now)).then(() => undefined);
  }

  find(urls: readonly string[], now = Date.now()): Promise<StoredHint | undefined> {
    return this.stored.get().then((list) => hintFor(list, urls, now));
  }
}
