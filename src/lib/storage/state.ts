import type { KeyValueArea } from './area';

/**
 * A typed value kept in a storage area (`storage.session` for state that may be lost with the browser session,
 * `storage.local` for what must stay). The background keeps nothing that matters in memory, because the worker can stop
 * at any moment; it reads and writes through one of these instead.
 */
export class StoredValue<T> {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param parse turns whatever is stored (possibly nothing, possibly from an older version) into a valid value; it
   * must not throw and returns the default for rubbish.
   */
  constructor(
    private readonly area: KeyValueArea,
    private readonly key: string,
    private readonly parse: (raw: unknown) => T,
  ) {}

  async get(): Promise<T> {
    return this.parse(await this.area.get(this.key));
  }

  /** Applies `change` to the current value; changes run one after another. */
  update(change: (current: T) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const next = change(await this.get());
      await this.area.set(this.key, next);
      return next;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  set(value: T): Promise<T> {
    return this.update(() => value);
  }
}
