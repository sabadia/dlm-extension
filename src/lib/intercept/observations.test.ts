import { describe, expect, it } from 'vitest';
import { capStoredBodies, type Observation } from './observations';

describe('capStoredBodies', () => {
  const obs = (id: string, size: number, at: number): Observation => ({
    requestId: id,
    url: `https://x.test/${id}`,
    method: 'POST',
    tabId: 1,
    requestHeaders: {},
    incognito: false,
    attachment: false,
    at,
    postBody: 'x'.repeat(size),
  });

  it('drops the oldest bodies first and keeps every observation', () => {
    const list = capStoredBodies([obs('a', 600, 1), obs('b', 600, 2), obs('c', 600, 3)], 1000);
    expect(list.map((item) => item.postBody?.length)).toEqual([undefined, undefined, 600]);
    expect(list).toHaveLength(3);
  });
});
