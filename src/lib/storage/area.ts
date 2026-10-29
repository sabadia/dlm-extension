/**
 * The small slice of `browser.storage` the extension uses, so that logic can be tested without a browser. Values are
 * JSON; a missing key reads as `undefined`.
 */
export interface KeyValueArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** What `browser.storage.<area>` offers that the adapter needs. */
interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Wraps a `browser.storage` area (local or session). */
export function browserArea(area: StorageAreaLike): KeyValueArea {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

/** An in-memory area for tests and for the first moments before storage is available. */
export function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(structuredClone(data.get(key))),
    set: (key, value) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    remove: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}
