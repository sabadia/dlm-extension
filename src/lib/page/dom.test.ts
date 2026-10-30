import { describe, expect, it } from 'vitest';
import {
  directLinkOfClick,
  hintLinks,
  nearbyText,
  pageIsProtected,
  pageLinks,
  pageSnapshot,
  throttled,
} from './dom';
import { isDirectScheme } from '../links/classify';
import { checksumIn } from './hints';

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

const sha = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('nearbyText', () => {
  it('uses the whole row when a row holds one link', () => {
    const d = doc(
      `<table><tr><td><a href="/a.zip">a.zip</a></td><td>SHA256 ${sha}</td></tr></table>`,
    );
    expect(checksumIn(nearbyText(d.querySelector('a') as Element))?.expected).toBe(sha);
  });

  it("keeps one file's hash from being taken for the next one's when several links share a block", () => {
    const d = doc(
      `<p><a href="/a.zip">a.zip</a> SHA256 ${sha} <a href="/b.zip">b.zip</a> SHA256 ${other}</p>`,
    );
    const [a, b] = [...d.querySelectorAll('a')];
    expect(checksumIn(nearbyText(a as Element))?.expected).toBe(sha);
    expect(checksumIn(nearbyText(b as Element))?.expected).toBe(other);
  });
});

describe('hintLinks', () => {
  it('gives web links with their own text, resolved against the page, and skips the rest', () => {
    const d = doc(
      '<ul><li><a href="/a.zip">A</a></li><li><a href="mailto:x@y.z">mail</a></li><li><a href="javascript:1">js</a></li></ul>',
    );
    expect(hintLinks(d, 'https://example.test/dl/').map((link) => link.url)).toEqual([
      'https://example.test/a.zip',
    ]);
  });

  it('stops at a limit on a huge page', () => {
    const html = Array.from({ length: 2500 }, (_v, i) => `<a href="/f${i}.zip">f</a>`).join('');
    expect(hintLinks(doc(html), 'https://example.test/')).toHaveLength(2000);
  });
});

describe('pageSnapshot', () => {
  it('reads the media of a page, capped, with short text', () => {
    const html =
      `<video src="/v.mp4"><source src="/v.webm"></video><audio src="/a.mp3"></audio>` +
      `<meta property="og:video" content="https://cdn.test/og.mp4">` +
      `<script type="application/ld+json">{"@type":"VideoObject"}</script>` +
      Array.from({ length: 700 }, (_v, i) => `<a href="/x${i}">${'t'.repeat(500)}</a>`).join('');
    const snapshot = pageSnapshot(doc(html), 'https://example.test/', { protectedMedia: false });
    expect(snapshot.videos).toEqual([{ src: '/v.mp4', sources: ['/v.webm'] }]);
    expect(snapshot.audios).toEqual([{ src: '/a.mp3', sources: [] }]);
    expect(snapshot.openGraph).toEqual(['https://cdn.test/og.mp4']);
    expect(snapshot.links).toHaveLength(500);
    expect(snapshot.links[0]?.text).toHaveLength(200);
  });

  it('knows protected media from the page itself, not only from an event that may have come early', () => {
    const d = doc('<video id="v"></video>');
    expect(pageIsProtected(d)).toBe(false);
    const video = d.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'mediaKeys', { value: {} });
    expect(pageIsProtected(d)).toBe(true);
    expect(pageSnapshot(d, 'https://example.test/', { protectedMedia: false }).protectedMedia).toBe(
      true,
    );
  });
});

describe('pageLinks', () => {
  it('lists links and media addresses of web schemes', () => {
    const d = doc(
      '<a href="/a.zip">A</a><img src="/i.png" alt="pic"><a href="data:text/plain,x">d</a>',
    );
    expect(pageLinks(d, 'https://example.test/').map((link) => [link.url, link.kind])).toEqual([
      ['https://example.test/a.zip', 'link'],
      ['https://example.test/i.png', 'image'],
    ]);
  });
});

describe('directLinkOfClick', () => {
  const anchor = (href: string) => {
    const d = doc(`<a href="${href}"><b>x</b></a>`);
    return d.querySelector('b') as Element;
  };
  const click = (over: Partial<MouseEvent>, target: Element) =>
    ({ isTrusted: true, button: 0, target, ...over }) as unknown as MouseEvent;

  it('takes a magnet link from a real click on its text', () => {
    expect(
      directLinkOfClick(click({}, anchor('magnet:?xt=urn:btih:abc')), isDirectScheme),
    ).toContain('magnet:');
  });

  it('ignores a click the page made up, a middle click, and other links', () => {
    const target = anchor('magnet:?xt=urn:btih:abc');
    expect(directLinkOfClick(click({ isTrusted: false }, target), isDirectScheme)).toBeUndefined();
    expect(directLinkOfClick(click({ button: 1 }, target), isDirectScheme)).toBeUndefined();
    expect(
      directLinkOfClick(click({}, anchor('https://example.test/')), isDirectScheme),
    ).toBeUndefined();
    expect(
      directLinkOfClick({ isTrusted: true, button: 0, target: null }, isDirectScheme),
    ).toBeUndefined();
  });
});

describe('throttled', () => {
  it('runs a page that changes all the time every interval, not never', () => {
    const timers: { at: number; run: () => void }[] = [];
    let now = 0;
    const fake = {
      setTimeout: ((run: () => void, ms: number) => {
        timers.push({ at: now + ms, run });
        return timers.length;
      }) as unknown as typeof globalThis.setTimeout,
    };
    let runs = 0;
    const scan = throttled(() => (runs += 1), 2000, fake);
    const advance = (to: number) => {
      while (timers.length > 0) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > to) break;
        timers.shift();
        now = next.at;
        next.run();
      }
      now = to;
    };
    for (let t = 0; t < 10_000; t += 100) {
      scan(); // a change every 100 ms
      advance(t + 100);
    }
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(runs).toBeLessThanOrEqual(6);
  });
});
