import { extensionForMime } from './kinds';

/** What a file is named after. */
export type NameSource = 'title' | 'url';

// Characters no common file system accepts in a name, and control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_NAME = 120;

/**
 * A file name from free text (a page title): no characters a file system refuses, no leading or trailing dots and
 * spaces, no reserved Windows names, and not longer than {@link MAX_NAME} characters.
 */
export function sanitizeFileName(text: string): string {
  let name = text.normalize('NFC').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`;
  return name;
}

/** The extension of a file name or address, lower case, without the dot. */
export function extensionOf(nameOrUrl: string | undefined): string | undefined {
  if (!nameOrUrl) return undefined;
  let path = nameOrUrl;
  try {
    path = new URL(nameOrUrl).pathname;
  } catch {
    // A plain file name.
  }
  const base = decodePath(path.split('/').pop() ?? '');
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : undefined;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The file name a link or a server names: the last part of the address, decoded. */
export function nameFromUrl(url: string): string | undefined {
  try {
    const base = decodePath(new URL(url).pathname.split('/').pop() ?? '');
    return sanitizeFileName(base) || undefined;
  } catch {
    return undefined;
  }
}

export interface NameFacts {
  /** Address of the file, after redirects when they were followed. */
  url: string;
  /** The name the server gave (Content-Disposition). */
  serverName?: string | undefined;
  mime?: string | undefined;
  /** A stream is saved as a video file. */
  stream?: boolean | undefined;
}

/** The extension of the file: from the server's name, the address, the type, or `mp4` for a stream. */
export function fileExtension(facts: NameFacts): string | undefined {
  if (facts.stream) return 'mp4';
  return extensionOf(facts.serverName) ?? extensionOf(facts.url) ?? extensionForMime(facts.mime);
}

/** The name a file has when it is named after its link or its server: the server's name first, then the address. */
export function nameFromLink(facts: NameFacts): string {
  if (facts.stream) {
    const stem = nameFromUrl(facts.url)?.replace(/\.[a-z0-9]{1,5}$/i, '') || 'stream';
    return `${stem}.mp4`;
  }
  const given = facts.serverName ? sanitizeFileName(facts.serverName) : '';
  if (given) return given;
  return (
    nameFromUrl(facts.url) ?? `download${fileExtension(facts) ? `.${fileExtension(facts)}` : ''}`
  );
}

/**
 * Names every file of a page. With `title`, a file is the page title plus its extension; when several files would get
 * the same name, each after the first gets the name of its own link in brackets, and then a number if even that is the
 * same. Without a usable title (or with `url`) a file keeps the name of its link.
 */
export function assignNames(
  files: readonly (NameFacts & { id: string })[],
  title: string,
  source: NameSource,
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const stem = source === 'title' ? sanitizeFileName(title) : '';
  for (const file of files) {
    let name: string;
    if (stem) {
      const ext = fileExtension(file);
      name = ext ? `${stem}.${ext}` : stem;
      if (used.has(name.toLowerCase())) {
        const own = nameFromLink(file).replace(/\.[a-z0-9]{1,8}$/i, '');
        const candidate = sanitizeFileName(`${stem} (${own})`);
        name = ext ? `${candidate}.${ext}` : candidate;
      }
    } else {
      name = nameFromLink(file);
    }
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n += 1) {
      const dot = name.lastIndexOf('.');
      unique = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    used.add(unique.toLowerCase());
    names.set(file.id, unique);
  }
  return names;
}
