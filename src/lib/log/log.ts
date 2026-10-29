import type { KeyValueArea } from '../storage/area';
import { redactText, redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Milliseconds since the epoch. */
  time: number;
  level: LogLevel;
  /** The part of the extension that wrote it (`native`, `client`, `pairing`, …). */
  scope: string;
  message: string;
  /** Redacted structured details, if any. */
  fields?: Record<string, unknown>;
}

export interface Logger {
  debug(scope: string, message: string, fields?: Record<string, unknown>): void;
  info(scope: string, message: string, fields?: Record<string, unknown>): void;
  warn(scope: string, message: string, fields?: Record<string, unknown>): void;
  error(scope: string, message: string, fields?: Record<string, unknown>): void;
}

/** Where the log is kept. It survives a restart of the worker; it is cleared when the browser closes. */
export const LOG_KEY = 'log';

/** The most entries kept; the oldest go first. */
export const LOG_CAPACITY = 500;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * A ring buffer of redacted entries, persisted in a key-value area (`storage.session` in the extension). Entries are
 * redacted when they are written, so nothing secret is ever stored; reading needs no further care.
 */
export class RingLog implements Logger {
  private entries: LogEntry[] | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly area: KeyValueArea,
    private readonly options: { capacity?: number; minLevel?: LogLevel; now?: () => number } = {},
  ) {}

  debug(scope: string, message: string, fields?: Record<string, unknown>): void {
    this.write('debug', scope, message, fields);
  }
  info(scope: string, message: string, fields?: Record<string, unknown>): void {
    this.write('info', scope, message, fields);
  }
  warn(scope: string, message: string, fields?: Record<string, unknown>): void {
    this.write('warn', scope, message, fields);
  }
  error(scope: string, message: string, fields?: Record<string, unknown>): void {
    this.write('error', scope, message, fields);
  }

  /** The entries, oldest first. */
  async read(): Promise<LogEntry[]> {
    await this.chain;
    return [...(await this.load())];
  }

  /** Empties the log. */
  async clear(): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.entries = [];
      await this.area.remove(LOG_KEY);
    });
    await this.chain;
  }

  private write(
    level: LogLevel,
    scope: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (ORDER[level] < ORDER[this.options.minLevel ?? 'info']) return;
    const entry: LogEntry = {
      time: (this.options.now ?? Date.now)(),
      level,
      scope,
      message: redactText(message),
    };
    if (fields) entry.fields = redactValue(fields) as Record<string, unknown>;
    // Writes are queued so that two quick entries never overwrite each other.
    this.chain = this.chain.then(async () => {
      const list = await this.load();
      list.push(entry);
      const capacity = this.options.capacity ?? LOG_CAPACITY;
      if (list.length > capacity) list.splice(0, list.length - capacity);
      try {
        await this.area.set(LOG_KEY, list);
      } catch {
        // Logging must never break the feature it describes.
      }
    });
  }

  private async load(): Promise<LogEntry[]> {
    if (this.entries) return this.entries;
    let stored: unknown;
    try {
      stored = await this.area.get(LOG_KEY);
    } catch {
      stored = undefined;
    }
    this.entries = Array.isArray(stored) ? (stored as LogEntry[]) : [];
    return this.entries;
  }
}

/** A logger that drops everything, for code that is tested without one. */
export const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** One line per entry, for the diagnostics report. */
export function formatEntry(e: LogEntry): string {
  const time = new Date(e.time).toISOString();
  const fields = e.fields ? ` ${JSON.stringify(e.fields)}` : '';
  return `${time} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}${fields}`;
}
