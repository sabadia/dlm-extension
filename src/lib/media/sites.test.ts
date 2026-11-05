import { describe, expect, it } from 'vitest';
import { isPlayerStream, videoPageOf, videoTitle } from './sites';

const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe('videoPageOf', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, 'video'],
    [`https://youtube.com/watch?v=${ID}&t=42s&list=PL123&index=3&si=abc`, 'video'],
    [`https://m.youtube.com/watch?v=${ID}`, 'video'],
    [`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`, 'video'],
    [`https://youtu.be/${ID}?t=5`, 'video'],
    [`https://www.youtube.com/shorts/${ID}`, 'short'],
    [`https://www.youtube.com/live/${ID}?feature=share`, 'live'],
    [`https://www.youtube.com/embed/${ID}`, 'video'],
  ])('%s is one video', (address, kind) => {
    expect(videoPageOf(address)).toEqual({ site: 'youtube', id: ID, kind, url: WATCH });
  });

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@someone/videos',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/shorts/',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://example.com/youtu.be/dQw4w9WgXcQ',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'not a url',
  ])('%s is not', (address) => {
    expect(videoPageOf(address)).toBeUndefined();
  });
});

describe('isPlayerStream', () => {
  it('knows the pieces the player fetches', () => {
    expect(
      isPlayerStream(
        'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4',
      ),
    ).toBe(true);
    expect(isPlayerStream('https://googlevideo.com/videoplayback')).toBe(true);
    expect(isPlayerStream('https://rr3---sn-abc.googlevideo.com/other')).toBe(false);
    expect(isPlayerStream('https://example.com/videoplayback')).toBe(false);
    expect(isPlayerStream('nope')).toBe(false);
  });
});

describe('videoTitle', () => {
  it('drops the site name and the notification count', () => {
    expect(videoTitle('youtube', 'Never Gonna Give You Up - YouTube')).toBe(
      'Never Gonna Give You Up',
    );
    expect(videoTitle('youtube', '(3)  A  -  B - YouTube')).toBe('A - B');
    expect(videoTitle('youtube', 'Song - YouTube Music')).toBe('Song');
    expect(videoTitle('youtube', 'YouTube')).toBe('YouTube');
  });
});
