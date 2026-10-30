/** The most bytes of a POST body the daemon will store for one task (capture.body, 256 KiB). */
export const MAX_POST_BODY = 256 * 1024;

export interface RawBodyPart {
  bytes?: ArrayBuffer | undefined;
}

/** What `webRequest` reports of a request body: raw parts, or the parsed fields of a form. */
export interface RawRequestBody {
  raw?: readonly RawBodyPart[] | undefined;
  formData?: Readonly<Record<string, readonly string[]>> | undefined;
}

/**
 * The body of a small POST as base64, or undefined when it is missing, empty, a file upload, not text, or larger than
 * {@link MAX_POST_BODY}. Only text can be replayed (the browser fallback sends the body as a string), so a binary body
 * stays with the browser. A parsed form (`formData`, which browsers give for url-encoded and multipart forms) is turned
 * back into a url-encoded body; the caller drops it when the request was multipart (see {@link isMultipart}).
 */
export function postBodyFrom(body: RawRequestBody | undefined): string | undefined {
  if (!body) return undefined;
  if (body.raw && body.raw.length > 0) return fromRaw(body.raw);
  if (body.formData) return fromForm(body.formData);
  return undefined;
}

/** Whether a `Content-Type` is a multipart form, which cannot be rebuilt from parsed fields. */
export function isMultipart(contentType: string | undefined): boolean {
  return contentType?.trim().toLowerCase().startsWith('multipart/') ?? false;
}

function fromRaw(parts: readonly RawBodyPart[]): string | undefined {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (!part.bytes) return undefined; // a file upload
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
  return isText(bytes) ? encodeBase64(bytes) : undefined;
}

function fromForm(fields: Readonly<Record<string, readonly string[]>>): string | undefined {
  const params = new URLSearchParams();
  for (const [name, values] of Object.entries(fields)) {
    for (const value of values) params.append(name, value);
  }
  const text = params.toString();
  if (text === '') return undefined;
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength > MAX_POST_BODY ? undefined : encodeBase64(bytes);
}

function isText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The text of a base64 body made by {@link postBodyFrom}. */
export function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const size = 0x1000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}
