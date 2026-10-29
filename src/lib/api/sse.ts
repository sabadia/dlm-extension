/** One event of the daemon's stream. */
export interface SseEvent {
  /** `<bootID>-<seq>`; send it back as `Last-Event-ID` to resume. */
  id: string | undefined;
  /** The event type (`task.status`, `reset`, …); `message` when the frame names none. */
  event: string;
  /** The `data` lines joined by newlines. */
  data: string;
}

/**
 * Reads Server-Sent Events from a byte stream. `EventSource` cannot send the `Authorization` header, so the stream is
 * read from a `fetch` response (docs/PLAN.md). Comments (`: ping`) and unknown fields are skipped; a frame with no
 * data is not an event.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | undefined;
  let event = '';
  let data: string[] = [];

  const flush = (): SseEvent | undefined => {
    const out =
      data.length > 0 ? { id, event: event || 'message', data: data.join('\n') } : undefined;
    event = '';
    data = [];
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffer.search(/\r\n|\n|\r/);
        if (end === -1) break;
        const lineBreak = /^\r\n/.test(buffer.slice(end)) ? 2 : 1;
        // A lone "\r" at the very end may be the first half of "\r\n": wait for more.
        if (buffer[end] === '\r' && lineBreak === 1 && end + 1 === buffer.length) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + lineBreak);
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let val = colon === -1 ? '' : line.slice(colon + 1);
          if (val.startsWith(' ')) val = val.slice(1);
          if (field === 'id') id = val;
          else if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
