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
  'state.checking': 'Checking the connection to DLM…',
  'state.hostNotInstalled':
    'DLM is not set up for this browser. Install DLM and choose Install under Manage ▸ Access.',
  'state.hostNotAllowed':
    'DLM does not accept this extension. Reinstall the DLM host from the DLM app.',
  'state.hostFailed': 'The DLM host failed: {message}',
  'state.appNotRunning': 'DLM is not running. Start the DLM app.',
  'state.localUnreachable':
    'DLM is running but this browser cannot reach it. Check the address and certificate.',
  'state.accessNeeded': 'Allow this extension to talk to DLM at {origin}.',
  'state.accessAllow': 'Allow access',
  'state.needsPairing': 'Connect this browser to DLM.',
  'state.pairing': 'Waiting for you to allow this browser in the DLM app…',
  'state.tokenRevoked': 'DLM no longer accepts this browser. Connect again.',
  'state.incompatible': 'This extension and DLM do not match. Update the older one.',
  'state.remoteNeedsToken': 'Enter the token of this DLM server.',
  'state.remoteUnreachable': 'The DLM server cannot be reached: {message}',
  'state.connected': 'Connected to DLM {version}.',
  'state.daemonTooOld': 'DLM {minVersion} or newer is needed. Update the DLM app.',
  'state.extensionTooOld': 'DLM needs a newer version of this extension. Update the extension.',
  'remote.title': 'DLM servers',
  'remote.help':
    'Send downloads to DLM on another computer. Use https:// where you can; the token is stored in this browser only.',
  'remote.local': 'DLM on this computer',
  'remote.active': 'Active',
  'remote.makeActive': 'Use this one',
  'remote.remove': 'Remove',
  'remote.noToken': 'No token',
  'remote.name': 'Name',
  'remote.url': 'Address',
  'remote.urlHint': 'For example https://dlm.example.test:17171',
  'remote.token': 'Token',
  'remote.test': 'Test',
  'remote.add': 'Add server',
  'remote.warnPlainHttp':
    'This address is not encrypted: the token and the addresses of your downloads can be read on the way. Use https:// if the server offers it.',
  'remote.selfSigned':
    'If the server uses a certificate it made itself, the browser must trust it: add it to the system, because an extension cannot accept it for you.',
  'remote.ok': 'Connected to DLM {version}.',
  'remote.added': 'Added.',
  'remote.accessDenied':
    'The browser did not allow access to this address, so the server was not added.',
  'remote.invalid.empty': 'Enter the address of the server.',
  'remote.invalid.invalid': 'That is not a valid address.',
  'remote.invalid.scheme': 'The address must start with https:// or http://.',
  'remote.invalid.credentials':
    'Leave the user name and password out of the address; use the token field.',
  'remote.unauthorized': 'The server did not accept this token.',
  'remote.unreachable': 'The server cannot be reached: {message}',
  'remote.failed': 'The test failed: {message}',
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
