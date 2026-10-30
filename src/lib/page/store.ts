import type { KeyValueArea } from '../storage/area';
import { StoredValue } from '../storage/state';
import { acceptedHints, hintFor, rememberPageHints, type PageHint, type StoredHint } from './hints';

function parseHints(raw: unknown): StoredHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: StoredHint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { at, origin } = item as { at?: unknown; origin?: unknown };
    if (typeof at !== 'number' || typeof origin !== 'string') continue;
    const [hint] = acceptedHints([item]);
    if (hint) hints.push({ ...hint, origin, at });
  }
  return hints;
}

/** Checksums and mirror links reported by pages, kept in `storage.session` so a restarted worker still has them. */
export class HintStore {
  private readonly stored: StoredValue<StoredHint[]>;

  constructor(area: KeyValueArea) {
    this.stored = new StoredValue(area, 'page.hints', parseHints);
  }

  /** Hints the page of `origin` reported. The origin comes from the sender of the message, never from the page. */
  note(hints: readonly PageHint[], origin: string, now = Date.now()): Promise<void> {
    return this.stored
      .update((list) => rememberPageHints(list, hints, origin, now))
      .then(() => undefined);
  }

  /** The hint for one of `urls` that a page of `origin` reported; none when the origin is not known. */
  find(
    urls: readonly string[],
    origin: string | undefined,
    now = Date.now(),
  ): Promise<StoredHint | undefined> {
    return this.stored.get().then((list) => hintFor(list, urls, origin, now));
  }
}
