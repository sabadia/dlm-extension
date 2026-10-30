import type { ConnectionState } from '../connection/state';
import type { PairingView } from '../pairing/service';
import type { AskChoice, AskPurpose } from '../intercept/service';
import type { PageHint } from '../page/hints';
import type { PageSnapshot } from '../media/page';
import type { DownloadRequest, TabView } from '../media/service';
import type { Settings, SettingsPatch } from '../settings/schema';
import type { Variant } from '../media/playlist';
import type { AddResult, RemoteTestResult, RemoteView } from '../remote/service';

/**
 * Every message between the parts of the extension (background, popup, options, content scripts), with the type of its
 * request and of its reply. Adding a message means adding it here, so both sides are checked against one definition.
 */
export interface MessageMap {
  /** The extension's own identity; the pages use it to show the version. */
  'ext.info': { request: undefined; response: { version: string } };
  /** The text to paste into a bug report. Never contains a token, cookie or credential. */
  'diagnostics.get': { request: undefined; response: string };
  /** The last known state of the connection to DLM, and the text for it. */
  'connection.get': { request: undefined; response: { state: ConnectionState; text: string } };
  /** Looks again now (the popup does this when it opens). */
  'connection.refresh': { request: undefined; response: { state: ConnectionState; text: string } };
  /** The targets (the local DLM and the servers added by hand), without tokens. */
  'remote.list': { request: undefined; response: RemoteView[] };
  /** Calls a server with a token and says what it found. Stores nothing. */
  'remote.test': { request: { url: string; token: string }; response: RemoteTestResult };
  /** Tests a server and saves it. The browser's access to it must already be granted (asked in the page, on a click). */
  'remote.add': { request: { name: string; url: string; token: string }; response: AddResult };
  'remote.replaceToken': { request: { id: string; token: string }; response: RemoteTestResult };
  'remote.remove': { request: { id: string }; response: null };
  'remote.setActive': { request: { id: string }; response: null };
  /** Empties the log. */
  'log.clear': { request: undefined; response: null };
  /** Where pairing with the DLM on this computer stands. */
  'pairing.view': { request: undefined; response: PairingView };
  /** Asks the DLM app to allow this extension; the reply carries the code to compare. */
  'pairing.start': { request: undefined; response: PairingView };
  /** Checks for the answer (call every couple of seconds while a pairing is pending). */
  'pairing.poll': { request: undefined; response: PairingView };
  'pairing.cancel': { request: undefined; response: PairingView };
  /** A content script reporting the modifier keys of a click or key press in its tab. */
  'gesture.note': { request: { alt: boolean; shift: boolean }; response: null };
  /** The name and site of a download the ask page is showing. Null when the prompt is gone. */
  'ask.get': {
    request: { id: string };
    response: {
      name: string;
      host: string;
      purpose: AskPurpose;
      checksum?: { algorithm: string; expected: string };
      mirrors?: string[];
    } | null;
  };
  /** Checksums and mirror links a content script saw. It does not start a download. */
  'page.hints': { request: { hints: PageHint[] }; response: null };
  /** The person's choice on the ask page. */
  'ask.choose': { request: { id: string; choice: AskChoice }; response: null };
  /** A magnet or eD2K link a content script caught before the browser could prompt. */
  'links.add': { request: { url: string }; response: boolean };
  /** The addresses the person picked on the links page. */
  'links.send': { request: { urls: string[] }; response: { ok: number; failed: number } };
  /** The media list of one tab. */
  'media.list': { request: { tabId: number }; response: TabView };
  /** A content script reporting what it found on its document. */
  'media.scan': { request: { snapshot: PageSnapshot }; response: null };
  /** An iframe of the tab plays protected (DRM) media. */
  'media.protected': { request: undefined; response: null };
  /** Sends one item, a chosen quality, or the page via yt-dlp or the daemon's browser. */
  'media.download': { request: DownloadRequest; response: { ok: boolean; error?: string } };
  /** Qualities of an HLS master playlist or a DASH manifest. */
  'media.variants': { request: { url: string }; response: Variant[] };
  /** Lazy name, size and duplicate hints for the open popup. */
  'media.probe': {
    request: { urls: string[] };
    response: { url: string; name?: string; size?: number; duplicate?: string }[];
  };
  /** The settings, without tokens. */
  'settings.get': { request: undefined; response: Settings };
  /** Saves the rules, preferences and routes. It is parsed again, so a bad field falls back to the default. */
  'settings.save': { request: SettingsPatch; response: Settings };
  /** The settings as a file. It contains no token. */
  'settings.export': { request: undefined; response: string };
  /** Replaces the settings from an exported file. A server with a new address starts without its token. */
  'settings.import': { request: { text: string }; response: Settings };
  /** Has DLM download a small file of its own (its health report) to show that the whole way works. */
  'downloads.test': { request: undefined; response: { ok: boolean; error?: string } };
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
