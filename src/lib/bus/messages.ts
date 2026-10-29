import type { PairingView } from '../pairing/service';

/**
 * Every message between the parts of the extension (background, popup, options, content scripts), with the type of its
 * request and of its reply. Adding a message means adding it here, so both sides are checked against one definition.
 */
export interface MessageMap {
  /** The extension's own identity; the pages use it to show the version. */
  'ext.info': { request: undefined; response: { version: string } };
  /** The text to paste into a bug report. Never contains a token, cookie or credential. */
  'diagnostics.get': { request: undefined; response: string };
  /** Empties the log. */
  'log.clear': { request: undefined; response: null };
  /** Where pairing with the DLM on this computer stands. */
  'pairing.view': { request: undefined; response: PairingView };
  /** Asks the DLM app to allow this extension; the reply carries the code to compare. */
  'pairing.start': { request: undefined; response: PairingView };
  /** Checks for the answer (call every couple of seconds while a pairing is pending). */
  'pairing.poll': { request: undefined; response: PairingView };
  'pairing.cancel': { request: undefined; response: PairingView };
}

export type MessageType = keyof MessageMap;
export type RequestOf<T extends MessageType> = MessageMap[T]['request'];
export type ResponseOf<T extends MessageType> = MessageMap[T]['response'];

/** What goes over the wire. */
export interface Envelope<T extends MessageType = MessageType> {
  /** Marks our messages, so a stray one from elsewhere is not mistaken for one. */
  dlm: 1;
  type: T;
  payload: RequestOf<T>;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
