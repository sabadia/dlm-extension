import { describe, expect, it } from 'vitest';
import { redactText, redactUrl, redactValue } from './redact';

describe('redactUrl', () => {
  it.each([
    ['https://user:pw@example.test/a', 'https://***@example.test/a'],
    ['https://example.test/a?token=abc&x=1', 'https://example.test/a?token=***&x=1'],
    [
      'https://example.test/a?Signature=zzz&X-Amz-Signature=keep',
      'https://example.test/a?Signature=***&X-Amz-Signature=keep',
    ],
    ['https://example.test/a#access_token=abc', 'https://example.test/a#***'],
    ['https://example.test/plain', 'https://example.test/plain'],
    ['data:text/plain;base64,AAAA', 'data:***'],
    ['not a url', 'not a url'],
  ])('%s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('redactText', () => {
  it('removes DLM tokens wherever they stand', () => {
    expect(redactText('paired, token dlmt_AbCdEf0123456789xyz stored')).toBe(
      'paired, token *** stored',
    );
    expect(redactText('primary dlm_0123456789abcdef')).toBe('primary ***');
  });
  it('removes authorization and cookie headers', () => {
    expect(redactText('Authorization: Bearer abcdef123456')).toBe('Authorization: ***');
    expect(redactText('sent Cookie: sid=1; other=2\nnext')).toBe('sent Cookie: ***\nnext');
    expect(redactText('using Bearer abcdef123456 now')).toBe('using Bearer *** now');
  });
  it('cleans URLs inside a sentence', () => {
    expect(redactText('GET https://u:p@h.test/x?password=1 failed')).toBe(
      'GET https://***@h.test/x?password=*** failed',
    );
  });
  it('leaves harmless text alone', () => {
    expect(redactText('connected to 127.0.0.1:50123')).toBe('connected to 127.0.0.1:50123');
  });
});

describe('redactValue', () => {
  it('masks secret keys and cleans strings, without changing the input', () => {
    const input = {
      url: 'https://h.test/?token=abc',
      token: 'dlmt_secretsecret1',
      nested: { Cookie: 'a=b', list: ['Bearer abcdef123456'], n: 3 },
    };
    const out = redactValue(input);
    expect(out).toEqual({
      url: 'https://h.test/?token=***',
      token: '***',
      nested: { Cookie: '***', list: ['Bearer ***'], n: 3 },
    });
    expect(input.token).toBe('dlmt_secretsecret1');
  });
  it('describes an error without leaking its message', () => {
    expect(redactValue(new Error('failed for dlmt_secretsecret1'))).toBe('Error: failed for ***');
  });
  it('stops at a sensible depth', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      deep.a = next;
      deep = next;
    }
    expect(JSON.stringify(redactValue(root))).toContain('[too deep]');
  });
});
