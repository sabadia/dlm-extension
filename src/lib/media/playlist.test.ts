import { describe, expect, it } from 'vitest';
import { hlsAttributes, parseDash, parseHls, parseXml } from './playlist';

const BASE = 'https://cdn.example.test/video/master.m3u8';

describe('parseHls', () => {
  it('reads a master playlist, sorted by bandwidth, with a hint for the daemon', () => {
    const variants = parseHls(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
        'low/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
        'https://other.example.test/high.m3u8?token=1&x=2',
      ].join('\n'),
      BASE,
    );
    expect(variants).toEqual([
      {
        url: 'https://other.example.test/high.m3u8?token=1&x=2',
        quality: '1080p',
        hint: '1080p',
        bandwidth: 5_000_000,
      },
      {
        url: 'https://cdn.example.test/video/low/index.m3u8',
        quality: '360p',
        hint: '360p',
        bandwidth: 1_000_000,
      },
    ]);
  });

  it('reads BANDWIDTH, not AVERAGE-BANDWIDTH, even when it comes first', () => {
    const [variant] = parseHls(
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900,BANDWIDTH=1200,RESOLUTION=1280x720\nm.m3u8',
      BASE,
    );
    expect(variant?.bandwidth).toBe(1200);
  });

  it('does not split attributes at a comma inside quotes', () => {
    const attributes = hlsAttributes('#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="a,b",NAME="x=y"');
    expect(attributes.get('CODECS')).toBe('a,b');
    expect(attributes.get('NAME')).toBe('x=y');
    expect(attributes.get('BANDWIDTH')).toBe('10');
  });

  it('knows a stream without a resolution: audio only, or just video', () => {
    const variants = parseHls(
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nv.m3u8',
      BASE,
    );
    expect(variants.map((v) => v.quality)).toEqual(['video', 'audio']);
    expect(variants[0]?.hint).toBe('https://cdn.example.test/video/v.m3u8');
  });

  it('has no variants in a media playlist, and ignores I-frame playlists and repeats', () => {
    expect(parseHls('#EXTM3U\n#EXTINF:4,\nseg1.ts\n', BASE)).toEqual([]);
    expect(
      parseHls(
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2\nm.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nm.m3u8',
        BASE,
      ),
    ).toHaveLength(1);
  });
});

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:x="x">
  <BaseURL>https://cdn.example.test/dash/</BaseURL>
  <Period>
    <BaseURL>p1/</BaseURL>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <BaseURL>v/</BaseURL>
      <Representation id="v1" bandwidth="4000000" height="1080"><BaseURL>1080.mp4?a=1&amp;b=2</BaseURL></Representation>
      <Representation id="v2" bandwidth="900000" height="360"><BaseURL>360.mp4</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <Representation id="a1" bandwidth="128000"><BaseURL>a.m4a</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('parseDash', () => {
  it('resolves the BaseURL chain, decodes entities, and reads what an adaptation set holds', () => {
    expect(parseDash(MPD, 'https://cdn.example.test/dash/manifest.mpd')).toEqual([
      {
        url: 'https://cdn.example.test/dash/p1/v/1080.mp4?a=1&b=2',
        quality: '1080p',
        hint: '1080p',
        bandwidth: 4_000_000,
      },
      {
        url: 'https://cdn.example.test/dash/p1/v/360.mp4',
        quality: '360p',
        hint: '360p',
        bandwidth: 900_000,
      },
      {
        url: 'https://cdn.example.test/dash/p1/a.m4a',
        quality: 'audio',
        hint: 'a1',
        bandwidth: 128_000,
      },
    ]);
  });

  it('uses the manifest itself for representations that come from a template, and keeps them apart', () => {
    const base = 'https://cdn.example.test/live/manifest.mpd';
    const variants = parseDash(
      `<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011"><mpd:Period><mpd:AdaptationSet><mpd:SegmentTemplate media="$Number$.m4s"/>
        <mpd:Representation id="a" bandwidth="1000" height="720"/><mpd:Representation id="b" bandwidth="2000" height="1080"/>
      </mpd:AdaptationSet></mpd:Period></mpd:MPD>`,
      base,
    );
    expect(variants.map((v) => [v.url, v.quality])).toEqual([
      [base, '1080p'],
      [base, '720p'],
    ]);
  });

  it('gives nothing for text that is not an MPD', () => {
    expect(parseDash('<html></html>', 'https://x.test/')).toEqual([]);
    expect(parseDash('not xml at all', 'https://x.test/')).toEqual([]);
  });
});

describe('parseXml', () => {
  it('copes with comments, CDATA, self-closing tags and a stray closing tag', () => {
    const root = parseXml('<a x="1"><!-- c --><b/><c><![CDATA[<raw>]]></c></d></a>');
    expect(root?.name).toBe('a');
    expect(root?.attributes.x).toBe('1');
    expect(root?.children.map((child) => child.name)).toEqual(['b', 'c']);
    expect(root?.children[1]?.text).toBe('<raw>');
  });
});
