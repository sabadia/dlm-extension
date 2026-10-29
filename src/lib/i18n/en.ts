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
  'pairing.title': 'Connect to DLM',
  'pairing.intro':
    'DLM asks you to allow this browser the first time. Nothing is sent before you do.',
  'pairing.start': 'Connect',
  'pairing.code': 'Check that DLM shows the same code, then choose Allow:',
  'pairing.waiting': 'Waiting for you to answer in the DLM app…',
  'pairing.cancel': 'Cancel',
  'pairing.approved': 'Connected.',
  'pairing.denied': 'DLM refused this browser. Choose Connect to try again.',
  'pairing.expired': 'The request ran out of time. Choose Connect to try again.',
  'pairing.error': 'Could not connect: {message}',
} as const;

export type MessageKey = keyof typeof en;
