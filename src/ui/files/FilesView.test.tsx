/* eslint-disable @typescript-eslint/require-await -- the fake API answers at once, as a promise */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../lib/settings/schema';
import type { DownloadRequest, TabView } from '../../lib/media/service';
import type { FilesApi } from './api';
import { FilesView } from './FilesView';

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

function fakeApi(items: TabView['items'], sizes: Record<string, number | undefined>) {
  const downloads: DownloadRequest[] = [];
  const probed: string[] = [];
  const api: FilesApi = {
    activeTab: async () => ({
      id: 1,
      url: 'https://site.test/page',
      title: 'Page',
      incognito: false,
    }),
    subscribe: () => () => undefined,
    mediaList: async () => ({
      items,
      title: 'Annual Report',
      protectedMedia: false,
      blobOrMse: false,
      pageUrl: 'https://site.test/page',
    }),
    probe: async (url) => {
      probed.push(url);
      const size = sizes[url];
      return size === undefined
        ? { ok: false, reason: 'size' }
        : { ok: true, finalUrl: url, sizeBytes: size };
    },
    settings: async () => defaultSettings(),
    saveFiles: async () => defaultSettings(),
    connection: async () => ({ kind: 'connected', text: 'Connected' }),
    queues: async () => [],
    download: async (request) => {
      downloads.push(request);
      return { ok: true };
    },
    variants: async () => [],
    cookiesPreview: async () => ({ host: 'site.test', count: 1 }),
    sendCookies: async () => ({
      ok: true,
      host: 'site.test',
      imported: 1,
      skipped: 0,
      rejected: 0,
    }),
    openSetup: () => undefined,
    openSettings: () => undefined,
    openPage: () => undefined,
    copy: async () => undefined,
  };
  return { api, downloads, probed };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FilesView', () => {
  it('lists only checked files, biggest first, named by the page title, and downloads one', async () => {
    const { api, downloads } = fakeApi(
      [
        { url: 'https://site.test/small.zip', kind: 'file', name: 'small.zip' },
        { url: 'https://site.test/big.iso', kind: 'file', name: 'big.iso' },
        { url: 'https://site.test/fake.zip', kind: 'file', name: 'fake.zip' },
      ],
      { 'https://site.test/small.zip': 1000, 'https://site.test/big.iso': 5_000_000 },
    );
    const el = document.createElement('div');
    document.body.append(el);
    await act(() => render(<FilesView api={api} />, el));
    await flush();
    await flush();
    const names = [...el.querySelectorAll('.file .name')].map((n) => n.textContent);
    expect(names).toEqual(['Annual Report.iso', 'Annual Report.zip']);
    expect(el.textContent).not.toContain('fake');
    await act(() => {
      (el.querySelector('.file .dl') as HTMLElement).click();
    });
    await flush();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toBe('Annual Report.iso');
    expect(downloads[0]?.url).toBe('https://site.test/big.iso');
  });
});
