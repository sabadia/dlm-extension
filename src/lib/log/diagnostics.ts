import { formatEntry, type LogEntry } from './log';
import { redactText, redactValue } from './redact';

export interface DiagnosticsInput {
  /** Extension version from the manifest. */
  version: string;
  /** The browser's user agent string. */
  userAgent: string;
  /** The connection state and anything else worth knowing, already plain data. */
  state: Record<string, unknown>;
  /** The settings; secret fields are removed here as well, whatever the caller did. */
  settings: unknown;
  log: readonly LogEntry[];
  /** How many log lines to include (the newest). */
  lines?: number;
}

/**
 * The text a person pastes into a bug report. It contains no token, cookie or credential: structured parts go through
 * {@link redactValue}, the whole text through {@link redactText} once more.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines = input.log.slice(-(input.lines ?? 200)).map(formatEntry);
  const text = [
    `DLM extension ${input.version}`,
    `Browser: ${input.userAgent}`,
    '',
    'State:',
    JSON.stringify(redactValue(input.state), null, 2),
    '',
    'Settings:',
    JSON.stringify(redactValue(input.settings), null, 2),
    '',
    `Log (newest ${lines.length}):`,
    ...lines,
  ].join('\n');
  return redactText(text);
}
