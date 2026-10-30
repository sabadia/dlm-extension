import { redactText } from '../log/redact';
import type { Envelope, MessageType, Reply, RequestOf, ResponseOf } from './messages';

/** Who sent a message, as far as the background can tell. */
export type SenderKind = 'extension-page' | 'content-script' | 'foreign';

/** The part of `runtime.MessageSender` the bus looks at. */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
  /** 0 for the top frame of a tab; another number for an iframe. */
  frameId?: number | undefined;
}

/** The part of `browser.runtime` the bus uses, so that tests need no browser. */
export interface RuntimeLike {
  /** The extension's id. */
  readonly id: string;
  /** The extension's base URL (`chrome-extension://<id>/`). */
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: SenderLike,
        sendResponse: (reply: unknown) => void,
      ) => boolean | undefined,
    ): void;
  };
}

/**
 * Tells who a sender is. Only our own pages and our own content scripts are ours: the id must be this extension's, and
 * a content script is told apart from a page by having a tab and a URL that is not the extension's.
 */
export function senderKind(
  runtime: Pick<RuntimeLike, 'id' | 'getURL'>,
  sender: SenderLike,
): SenderKind {
  if (sender.id !== runtime.id) return 'foreign';
  const base = runtime.getURL('');
  if (sender.url?.startsWith(base)) return 'extension-page';
  if (sender.tab !== undefined && sender.url !== undefined) return 'content-script';
  return 'foreign';
}

/** Whether the message came from the top frame of a tab (not an iframe of the page). */
export function isTopFrame(sender: SenderLike): boolean {
  return sender.frameId === 0;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.dlm === 1 && typeof v.type === 'string';
}

/** Sends a message to the background and returns its reply; a failure on the other side rejects. */
export async function sendMessage<T extends MessageType>(
  runtime: Pick<RuntimeLike, 'sendMessage'>,
  type: T,
  ...payload: RequestOf<T> extends undefined ? [] : [RequestOf<T>]
): Promise<ResponseOf<T>> {
  const envelope: Envelope<T> = { dlm: 1, type, payload: payload[0] };
  const reply = (await runtime.sendMessage(envelope)) as Reply<ResponseOf<T>> | undefined;
  if (!reply) throw new Error('The extension background did not answer.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export type Handler<T extends MessageType> = (
  payload: RequestOf<T>,
  sender: SenderLike,
) => Promise<ResponseOf<T>> | ResponseOf<T>;

/** What may send a message: extension pages (popup, options) by default; content scripts only where a handler says so. */
export interface HandlerSpec<T extends MessageType> {
  handle: Handler<T>;
  /** Also accept it from content scripts. Their input is untrusted: such a handler must validate it. */
  fromContent?: boolean;
}

export type Handlers = { [T in MessageType]?: HandlerSpec<T> };

/**
 * Registers the one `runtime.onMessage` listener. It must be called synchronously while the background loads, so that a
 * message that wakes a stopped worker is not lost (docs/CONVENTIONS.md). Foreign senders and unknown messages are
 * ignored (no reply); a handler that throws replies with a redacted error.
 */
export function listen(
  runtime: RuntimeLike,
  handlers: Handlers,
  onError?: (type: string, error: unknown) => void,
): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isEnvelope(message)) return undefined;
    const kind = senderKind(runtime, sender);
    const spec = handlers[message.type] as HandlerSpec<MessageType> | undefined;
    if (!spec || kind === 'foreign' || (kind === 'content-script' && !spec.fromContent))
      return undefined;
    // Answer asynchronously: returning true keeps the channel open on every browser.
    void Promise.resolve()
      .then(() => spec.handle(message.payload, sender))
      .then(
        (value) => sendResponse({ ok: true, value } satisfies Reply<unknown>),
        (error: unknown) => {
          onError?.(message.type, error);
          sendResponse({
            ok: false,
            error: redactText(error instanceof Error ? error.message : 'failed'),
          } satisfies Reply<unknown>);
        },
      );
    return true;
  });
}
