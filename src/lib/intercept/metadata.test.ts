import { describe, expect, it } from 'vitest';
import {
  basename,
  buildCaptureBody,
  contentLength,
  cookieMatchesHost,
  filenameFromDisposition,
  headerValue,
  isAttachment,
  pickRequestHeaders,
  toCaptureCookie,
} from './metadata';
import {
  matchObservation,
  mergeObservation,
  readGesture,
  rememberGesture,
  rememberObservation,
  type Observation,
} from './observations';

const observed = (over: Partial<Observation> = {}): Observation => ({
  requestId: '1',
  url: 'https://files.example.test/a.zip',
  method: 'GET',
  tabId: 3,
  requestHeaders: {},
  incognito: false,
  attachment: false,
  at: 1_000,
  ...over,
});

describe('request metadata', () => {
  it('keeps the allow-listed request headers and drops cookies and the host', () => {
    expect(
      pickRequestHeaders([
        { name: 'Accept', value: 'application/zip' },
        { name: 'Cookie', value: 'session=secret' },
        { name: 'Host', value: 'files.example.test' },
        { name: 'Authorization', value: 'Bearer token' },
        { name: 'X-Custom', value: 'no' },
        { name: 'Accept', value: 'application/octet-stream' },
      ]),
    ).toEqual({
      accept: 'application/zip, application/octet-stream',
      authorization: 'Bearer token',
    });
  });

  it('reads a disposition file name, including the UTF-8 form', () => {
    expect(filenameFromDisposition('attachment; filename="report.pdf"')).toBe('report.pdf');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.zip")).toBe('café.zip');
    expect(isAttachment('inline')).toBe(false);
    expect(isAttachment('Attachment; filename=a.bin')).toBe(true);
    expect(headerValue([{ name: 'Content-Type', value: 'text/plain' }], 'content-type')).toBe(
      'text/plain',
    );
    expect(contentLength('2048')).toBe(2048);
    expect(contentLength('nope')).toBeUndefined();
    expect(basename('/home/a/file.zip')).toBe('file.zip');
    expect(basename('C:\\Users\\a\\file.zip')).toBe('file.zip');
  });

  it("maps only the download host's cookies, with the partition key and no session expiry", () => {
    expect(cookieMatchesHost('.example.test', 'cdn.example.test')).toBe(true);
    expect(cookieMatchesHost('other.test', 'cdn.example.test')).toBe(false);
    expect(
      toCaptureCookie(
        {
          domain: '.example.test',
          name: 'sid',
          value: 'v',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: false,
          sameSite: 'no_restriction',
          session: true,
          partitionKey: { topLevelSite: 'https://example.test' },
        },
        'cdn.example.test',
      ),
    ).toEqual({
      domain: '.example.test',
      name: 'sid',
      value: 'v',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'none',
      partitionKey: 'https://example.test',
    });
    expect(
      toCaptureCookie({ domain: 'other.test', name: 'a', value: 'b' }, 'example.test'),
    ).toBeUndefined();
  });

  it('builds a per-task capture and drops the directory from a Firefox path', () => {
    expect(
      buildCaptureBody({
        url: 'https://start.example.test/a',
        finalUrl: 'https://cdn.example.test/a.zip',
        pageUrl: 'https://example.test/page',
        referrer: 'https://example.test/page',
        filename: '/tmp/a.zip',
        mime: 'application/zip; charset=binary',
        sizeBytes: 50,
        userAgent: 'UA',
        headers: { accept: '*/*' },
        cookies: [{ domain: 'cdn.example.test', name: 'n', value: 'v' }],
      }),
    ).toMatchObject({
      url: 'https://start.example.test/a',
      finalUrl: 'https://cdn.example.test/a.zip',
      filename: 'a.zip',
      mime: 'application/zip',
      cookieScope: 'task',
      userAgent: 'UA',
    });
  });
});

describe('observations', () => {
  it('keeps the first address and the request headers when the response arrives', () => {
    const first = observed({ requestHeaders: { accept: '*/*' }, userAgent: 'UA' });
    const response = observed({
      url: 'https://cdn.example.test/a.zip',
      finalUrl: 'https://cdn.example.test/a.zip',
      mime: 'application/zip',
      attachment: true,
      requestHeaders: {},
      at: 1_010,
    });
    const merged = mergeObservation(first, response);
    expect(merged.url).toBe('https://files.example.test/a.zip');
    expect(merged.finalUrl).toBe('https://cdn.example.test/a.zip');
    expect(merged.requestHeaders).toEqual({ accept: '*/*' });
    expect(merged.userAgent).toBe('UA');
    expect(merged.attachment).toBe(true);
  });

  it('matches the newest observation for a download address and forgets an old one', () => {
    const list = rememberObservation(
      [observed({ requestId: 'old', at: 0 })],
      observed({ requestId: 'new', finalUrl: 'https://cdn.example.test/a.zip', at: 5_000 }),
      5_000,
    );
    expect(matchObservation(list, ['https://cdn.example.test/a.zip'], 5_000)?.requestId).toBe(
      'new',
    );
    expect(matchObservation(list, ['https://cdn.example.test/a.zip'], 30_000)).toBeUndefined();
  });

  it('remembers a modifier key for a few seconds', () => {
    const map = rememberGesture({}, 7, true, false, 1_000);
    expect(readGesture(map, 7, 2_000)).toEqual({ alt: true, shift: false });
    expect(readGesture(map, 7, 5_000)).toEqual({ alt: false, shift: false });
    expect(readGesture(map, undefined, 2_000)).toEqual({ alt: false, shift: false });
  });
});

describe('Content-Disposition review fixes', () => {
  it('reads a filename* with a language tag and a non-UTF-8 charset', () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8'en'report.pdf")).toBe('report.pdf');
    expect(filenameFromDisposition("attachment; filename*=iso-8859-1''%A3rates.txt")).toBe(
      '£rates.txt',
    );
    expect(filenameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve%20file.txt")).toBe(
      'naïve file.txt',
    );
  });

  it('falls back to the plain filename when the extended one cannot be read', () => {
    expect(
      filenameFromDisposition(
        'attachment; filename*=unknown-charset\'\'x%ZZ; filename="plain.txt"',
      ),
    ).toBe('plain.txt');
  });

  it('counts only the disposition type, not a file name that contains the word', () => {
    expect(isAttachment('attachment; filename="a.zip"')).toBe(true);
    expect(isAttachment('Attachment')).toBe(true);
    expect(isAttachment('inline; filename="attachment-guide.pdf"')).toBe(false);
  });
});
