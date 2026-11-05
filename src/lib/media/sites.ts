/**
 * Video sites whose pages the daemon downloads itself (through yt-dlp). Their players fetch signed, throttled pieces
 * (audio and video apart, in ranges), so the network requests of the page are no download: the page address is.
 */

export type VideoSite = 'youtube';

export interface VideoPage {
  site: VideoSite;
  /** The site's id of the video. */
  id: string;
  kind: 'video' | 'short' | 'live';
  /** The address to hand to the daemon: the video alone, without playlist, time or tracking parameters. */
  url: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

/** The video a page address is about, or undefined when it is not the page of one video. */
export function videoPageOf(address: string): VideoPage | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return youtube(id, 'video');
  }
  if (!YOUTUBE_HOSTS.has(host)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'watch') return youtube(url.searchParams.get('v') ?? '', 'video');
  if (parts[0] === 'shorts') return youtube(parts[1] ?? '', 'short');
  if (parts[0] === 'live') return youtube(parts[1] ?? '', 'live');
  if (parts[0] === 'embed') return youtube(parts[1] ?? '', 'video');
  return undefined;
}

function youtube(id: string, kind: VideoPage['kind']): VideoPage | undefined {
  if (!YOUTUBE_ID.test(id)) return undefined;
  return { site: 'youtube', id, kind, url: `https://www.youtube.com/watch?v=${id}` };
}

/** True for the media requests of a video site's player: not downloads, see the top of this file. */
export function isPlayerStream(address: string): boolean {
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    return (
      (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) &&
      url.pathname.startsWith('/videoplayback')
    );
  } catch {
    return false;
  }
}

/** The title of a video page without the site's name the browser appends (`Title - YouTube`). */
export function videoTitle(site: VideoSite, pageTitle: string): string {
  const title = pageTitle.replace(/\s+/g, ' ').trim();
  switch (site) {
    case 'youtube':
      // A count of notifications may lead: "(3) Title - YouTube".
      return title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*(YouTube|YouTube Music)\s*$/i, '');
  }
}
