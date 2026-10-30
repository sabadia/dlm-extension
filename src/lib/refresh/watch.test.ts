import { describe, expect, it } from 'vitest';
import { freshNotices, refreshNotices, SEEN_TTL_MS, storedPage } from './watch';

describe('storedPage', () => {
  it('uses the stored page, then the original address', () => {
    expect(
      storedPage({
        pageUrl: 'https://files.example.test/release',
        originalUrl: 'https://cdn.example.test/a.zip',
      }),
    ).toBe('https://files.example.test/release');
    expect(storedPage({ originalUrl: 'https://files.example.test/release' })).toBe(
      'https://files.example.test/release',
    );
  });

  it('ignores anything that is not an http(s) page', () => {
    expect(storedPage({ pageUrl: 'ftp://files.example.test/a' })).toBeUndefined();
    expect(storedPage(undefined)).toBeUndefined();
  });
});

describe('refreshNotices', () => {
  it('keeps only tasks that are waiting for a link', () => {
    expect(
      refreshNotices([
        {
          id: '1',
          status: 'awaiting_link',
          name: 'Setup',
          source: { pageUrl: 'https://files.example.test/setup' },
        },
        { id: '2', status: 'running', name: 'Other' },
        { id: '', status: 'awaiting_link' },
        { id: '3', status: 'awaiting_link', source: { pageUrl: 'not a url' } },
      ]),
    ).toEqual([
      { id: '1', name: 'Setup', pageUrl: 'https://files.example.test/setup' },
      { id: '3', name: 'Download' },
    ]);
  });
});

describe('freshNotices', () => {
  const notice = {
    id: '1',
    name: 'Setup',
    server: 'http://a',
    pageUrl: 'https://files.example.test/setup',
  };
  const key = 'http://a\n1';

  it('shows a task once, and again after it stops waiting on a server that answered', () => {
    const first = freshNotices([notice], [], new Set(['http://a']), 10);
    expect(first.fresh).toEqual([notice]);
    expect(freshNotices([notice], first.seen, new Set(['http://a']), 11).fresh).toEqual([]);
    const gone = freshNotices([], first.seen, new Set(['http://a']), 12);
    expect(gone.seen).toEqual([]);
    expect(freshNotices([notice], gone.seen, new Set(['http://a']), 13).fresh).toEqual([notice]);
  });

  it('keeps what it knows about a server that did not answer', () => {
    const kept = freshNotices([], [{ key, at: 10 }], new Set(), 11);
    expect(kept.seen).toEqual([{ key, at: 10 }]);
  });

  it('forgets a notice after a week', () => {
    expect(
      freshNotices([notice], [{ key, at: 0 }], new Set(['http://a']), SEEN_TTL_MS + 1).fresh,
    ).toEqual([notice]);
  });
});
