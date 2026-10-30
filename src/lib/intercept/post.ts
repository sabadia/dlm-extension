/** The most bytes of a POST body the daemon will store for one task (capture.body, 256 KiB). */
export const MAX_POST_BODY = 256 * 1024;

export interface RawBodyPart {
  bytes?: ArrayBuffer | undefined;
}

/**
 * The body of a small POST, base64, or undefined when it is missing, empty, a file upload, or larger than
 * {@link MAX_POST_BODY}. A download the extension cannot replay stays in the browser.
 */
export function postBodyFrom(parts: readonly RawBodyPart[] | undefined): string | undefined {
  if (!parts || parts.length === 0) return undefined;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (!part.bytes) return undefined;
    chunks.push(new Uint8Array(part.bytes));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total === 0 || total > MAX_POST_BODY) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encodeBase64(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const size = 0x1000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}
