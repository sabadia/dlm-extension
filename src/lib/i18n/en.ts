/**
 * The message catalogue (English). Every string a person reads comes from here, so that translation (E5.9) is a matter
 * of adding a catalogue, not of finding strings in components.
 */
export const en = {
  'options.title': 'DLM options',
  'options.diagnostics.title': 'Diagnostics',
  'options.diagnostics.help':
    'Copies a report for a bug report: versions, connection state, settings and recent log lines. It contains no token, cookie or password.',
  'options.diagnostics.copy': 'Copy diagnostics',
  'options.diagnostics.copied': 'Copied.',
  'options.diagnostics.failed': 'Could not copy: {reason}',
  'popup.notConnected': 'Not connected yet.',
} as const;

export type MessageKey = keyof typeof en;
