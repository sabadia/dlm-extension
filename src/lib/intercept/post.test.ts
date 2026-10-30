import { describe, expect, it } from 'vitest';
import { MAX_POST_BODY, postBodyFrom } from './post';

describe('postBodyFrom', () => {
  it('encodes a small body and refuses a file, an empty body and a large one', () => {
    const bytes = new Uint8Array([104, 105]).buffer;
    expect(postBodyFrom([{ bytes }])).toBe(btoa('hi'));
    expect(postBodyFrom([{ bytes: undefined }])).toBeUndefined();
    expect(postBodyFrom([])).toBeUndefined();
    expect(postBodyFrom([{ bytes: new Uint8Array(MAX_POST_BODY + 1).buffer }])).toBeUndefined();
  });
});
