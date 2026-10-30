import { describe, expect, it } from 'vitest';
import { freshNotices, refreshNotices, storedPage } from './watch';

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
      { id: '3', name: 'download' },
    ]);
  });
});

describe('freshNotices', () => {
  const notice = { id: '1', name: 'Setup', pageUrl: 'https://files.example.test/setup' };

  it('shows a task once, and again after it stops waiting', () => {
    const first = freshNotices([notice], []);
    expect(first.fresh).toEqual([notice]);
    expect(freshNotices([notice], first.seen).fresh).toEqual([]);
    expect(freshNotices([notice], []).fresh).toEqual([notice]);
  });
});
