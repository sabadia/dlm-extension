import { describe, expect, it } from 'vitest';
import { decodeBase64Text, isMultipart, MAX_POST_BODY, postBodyFrom } from './post';

const raw = (...bytes: number[]) => ({ raw: [{ bytes: new Uint8Array(bytes).buffer }] });

describe('postBodyFrom', () => {
  it('encodes a small text body', () => {
    expect(postBodyFrom(raw(104, 105))).toBe(btoa('hi'));
  });

  it('joins several parts', () => {
    const body = {
      raw: [{ bytes: new Uint8Array([97, 61]).buffer }, { bytes: new Uint8Array([49]).buffer }],
    };
    expect(decodeBase64Text(postBodyFrom(body) ?? '')).toBe('a=1');
  });

  it('refuses a file, an empty body, a large one, and binary data', () => {
    expect(postBodyFrom({ raw: [{ bytes: undefined }] })).toBeUndefined();
    expect(postBodyFrom({ raw: [] })).toBeUndefined();
    expect(postBodyFrom(undefined)).toBeUndefined();
    expect(
      postBodyFrom({ raw: [{ bytes: new Uint8Array(MAX_POST_BODY + 1).buffer }] }),
    ).toBeUndefined();
    expect(postBodyFrom(raw(0xff, 0xfe, 0x00))).toBeUndefined();
  });

  it('rebuilds a parsed form as a url-encoded body', () => {
    const body = postBodyFrom({ formData: { file: ['a b'], tag: ['x', 'y&z'] } });
    expect(decodeBase64Text(body ?? '')).toBe('file=a+b&tag=x&tag=y%26z');
    expect(postBodyFrom({ formData: {} })).toBeUndefined();
  });

  it('keeps non-ASCII text intact', () => {
    const body = postBodyFrom({ formData: { name: ['é☃'] } });
    expect(decodeBase64Text(body ?? '')).toBe('name=%C3%A9%E2%98%83');
  });
});

describe('isMultipart', () => {
  it('spots a multipart form', () => {
    expect(isMultipart('multipart/form-data; boundary=x')).toBe(true);
    expect(isMultipart('application/x-www-form-urlencoded')).toBe(false);
    expect(isMultipart(undefined)).toBe(false);
  });
});
