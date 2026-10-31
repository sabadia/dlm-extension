import { describe, expect, it } from 'vitest';
import type { CaptureCookie } from '../api/client';
import { fitCaptureLimits, MAX_CAPTURE_COOKIES, MAX_COOKIES_TOTAL } from './cookies';

describe('fitCaptureLimits', () => {
  const cookie = (
    name: string,
    value = 'v',
    path = '/',
    domain = 'example.test',
  ): CaptureCookie => ({
    domain,
    name,
    value,
    path,
    hostOnly: false,
  });

  it('keeps a small jar as it is, in order', () => {
    const jar = [cookie('a'), cookie('b')];
    expect(fitCaptureLimits(jar)).toEqual(jar);
  });

  it('drops a cookie over 8 KiB and caps the count at 200, keeping the more specific ones', () => {
    const jar = [
      cookie('huge', 'x'.repeat(9000)),
      ...Array.from({ length: 250 }, (_, i) => cookie(`c${i}`)),
      cookie('deep', 'v', '/a/b/c'),
    ];
    const fitted = fitCaptureLimits(jar);
    expect(fitted).toHaveLength(MAX_CAPTURE_COOKIES);
    expect(fitted.map((c) => c.name)).not.toContain('huge');
    expect(fitted.map((c) => c.name)).toContain('deep');
  });

  it('stays below 256 KiB together', () => {
    const jar = Array.from({ length: 100 }, (_, i) => cookie(`c${i}`, 'x'.repeat(4000)));
    const total = fitCaptureLimits(jar).reduce(
      (sum, c) => sum + c.name.length + c.value.length + c.domain.length + (c.path?.length ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_COOKIES_TOTAL);
  });
});
