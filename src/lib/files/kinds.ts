/** What a file is, for the type chips and the icon. */
export type FileKind =
  'video' | 'audio' | 'archive' | 'document' | 'app' | 'image' | 'stream' | 'other';

const GROUPS: Record<Exclude<FileKind, 'other' | 'stream'>, string[]> = {
  video: [
    'mp4',
    'm4v',
    'mkv',
    'webm',
    'avi',
    'mov',
    'wmv',
    'flv',
    'ts',
    'mpg',
    'mpeg',
    '3gp',
    'ogv',
  ],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img'],
  document: [
    'pdf',
    'epub',
    'mobi',
    'azw3',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'odt',
    'ods',
    'odp',
    'csv',
    'rtf',
  ],
  app: ['exe', 'msi', 'apk', 'deb', 'rpm', 'pkg', 'dmg', 'appimage', 'jar', 'ipa', 'msix'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif', 'heic'],
};

const BY_EXT = new Map<string, FileKind>();
for (const [kind, list] of Object.entries(GROUPS)) {
  for (const ext of list) BY_EXT.set(ext, kind as FileKind);
}
BY_EXT.set('m3u8', 'stream');
BY_EXT.set('mpd', 'stream');
BY_EXT.set('torrent', 'other');

/**
 * Extensions of links that look like a download. Images are not among them: a page links its thumbnails everywhere, and
 * none of those is a file the person came for (an image with the `download` attribute is still taken).
 */
export const DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set(
  [...BY_EXT].filter(([, kind]) => kind !== 'image').map(([ext]) => ext),
);

export function kindFromExtension(ext: string | undefined): FileKind | undefined {
  return ext ? BY_EXT.get(ext.toLowerCase()) : undefined;
}

export function kindFromMime(mime: string | undefined): FileKind | undefined {
  const type = mime?.split(';')[0]?.trim().toLowerCase();
  if (!type) return undefined;
  if (
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl' ||
    type === 'application/dash+xml'
  )
    return 'stream';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('image/')) return 'image';
  if (/zip|rar|7z|tar|gzip|x-bzip|x-xz|zstd|x-iso9660/.test(type)) return 'archive';
  if (/pdf|epub|msword|officedocument|ms-excel|ms-powerpoint|opendocument|rtf|csv/.test(type))
    return 'document';
  if (
    /x-msdownload|x-msi|vnd.android.package|x-debian|x-rpm|x-apple-diskimage|java-archive/.test(
      type,
    )
  )
    return 'app';
  return undefined;
}

/** The kind of a file: its extension decides, then its type. */
export function fileKindOf(facts: {
  ext?: string | undefined;
  mime?: string | undefined;
}): FileKind {
  return kindFromExtension(facts.ext) ?? kindFromMime(facts.mime) ?? 'other';
}

/** A file extension for a content type, for a file whose address and name have none. */
const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'application/zip': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/vnd.android.package-archive': 'apk',
  'application/x-msdownload': 'exe',
  'application/x-apple-diskimage': 'dmg',
  'application/x-bittorrent': 'torrent',
};

export function extensionForMime(mime: string | undefined): string | undefined {
  const type = mime?.split(';')[0]?.trim().toLowerCase();
  return type ? MIME_EXT[type] : undefined;
}
