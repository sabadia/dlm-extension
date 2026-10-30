import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Extension } from '../support/fixtures';
import type { Daemon } from '../support/daemon';
import { FILES, PAGE_TITLE, body, sha256 } from '../support/site';

interface Task {
  id: string;
  name: string;
  status: string;
  source: { currentUrl: string; originalUrl?: string; cookieDomains?: string[] };
}

const tasksOf = async (daemon: Daemon): Promise<Task[]> => {
  const list = await daemon.api<{ tasks?: Task[] } | Task[]>('GET', '/v1/tasks');
  return Array.isArray(list) ? list : (list.tasks ?? []);
};

/** Rules that take every download, however small, so the small fixture files are taken over. */
async function takeEverything(extension: Extension): Promise<void> {
  const settings = await extension.send('settings.get');
  await extension.send('settings.save', {
    rules: { ...settings.rules, minSizeBytes: 0 },
    preferences: settings.preferences,
    routes: settings.routes,
    files: settings.files,
  });
}

test.describe('with DLM connected', () => {
  test('a download the browser starts is taken over, downloaded by DLM and the bytes are right', async ({
    context,
    daemon,
    extension,
    site,
    until,
  }) => {
    await extension.pair();
    await takeEverything(extension);
    const page = await context.newPage();
    await page.goto(`${site.origin}/attachments`);
    await page.click('#export');

    // The server's own file name (Content-Disposition), not the title of the page: this download is not renamed.
    const task = await until('the task in DLM', async () =>
      (await tasksOf(daemon)).find((item) => item.name === 'export_final_v2.bin'),
    );
    expect(task.source.currentUrl).toBe(`${site.origin}${FILES.attachment.path}`);
    const bytes = await until('the file', () => {
      const file = join(daemon.downloads, task.name);
      return existsSync(file) ? readFileSync(file) : false;
    });
    expect(sha256(bytes)).toBe(sha256(body('attachment', FILES.attachment.size)));
  });

  test('a file behind a sign-in is downloaded with the browser’s cookies, and the site’s cookies can be sent to DLM', async ({
    context,
    daemon,
    extension,
    site,
    until,
  }) => {
    await extension.pair();
    await context.addCookies([{ name: 'sid', value: 'ok', url: site.origin }]);
    const page = await context.newPage();
    await page.goto(`${site.origin}/members`);
    const panel = await extension.filesPanel(await extension.tabId('/members'));
    await expect(panel.locator('.file')).toHaveCount(1);
    await panel.locator('.file .dl').click();

    const task = await until('the task in DLM', async () =>
      (await tasksOf(daemon)).find((item) => item.source.currentUrl.endsWith(FILES.gated.path)),
    );
    const bytes = await until('the file', () => {
      const file = join(daemon.downloads, task.name);
      return existsSync(file) ? readFileSync(file) : false;
    });
    expect(sha256(bytes)).toBe(sha256(body('gated', FILES.gated.size)));

    // Sending the site's cookies: asked first, then kept by DLM.
    const tabId = await extension.tabId('/members');
    const preview = await extension.send('media.cookies.preview', {
      url: `${site.origin}/members`,
      tabId,
    });
    expect(preview.count).toBeGreaterThan(0);
    const sent = await extension.send('media.cookies.send', {
      url: `${site.origin}/members`,
      tabId,
    });
    expect(sent).toMatchObject({ ok: true });
    const stored = await daemon.api<{ cookies?: { name: string }[] } | { name: string }[]>(
      'GET',
      '/v1/cookies',
    );
    const cookies = Array.isArray(stored) ? stored : (stored.cookies ?? []);
    expect(cookies.map((cookie) => cookie.name)).toContain('sid');
  });

  test('a magnet link on a page goes to DLM', async ({
    context,
    daemon,
    extension,
    site,
    until,
  }) => {
    await extension.pair();
    const page = await context.newPage();
    await page.goto(`${site.origin}/magnets`);
    await page.click('#magnet');
    const task = await until('the magnet task', async () =>
      (await tasksOf(daemon)).find((item) => item.source.currentUrl.startsWith('magnet:')),
    );
    expect(task.source.currentUrl).toContain('0123456789abcdef0123456789abcdef01234567');
  });

  test('a stream the page loads is listed and sent to DLM', async ({
    context,
    daemon,
    extension,
    site,
    until,
  }) => {
    await extension.pair();
    const page = await context.newPage();
    await page.goto(`${site.origin}/stream`);
    const panel = await extension.filesPanel(await extension.tabId('/stream'));
    const row = panel.locator('.file', { hasText: 'Stream' });
    await expect(row.first()).toBeVisible();
    await expect(row.first().locator('.name')).toContainText('Live stream page');
    await row.first().locator('.dl').click();
    await until('the stream task', async () =>
      (await tasksOf(daemon)).find((item) => item.source.currentUrl.includes('/hls/')),
    );
  });

  test('the page title is the default name in the Files panel and the file name is one click away', async ({
    context,
    extension,
    site,
  }) => {
    await extension.pair();
    const page = await context.newPage();
    await page.goto(`${site.origin}/page`);
    const panel = await extension.filesPanel(await extension.tabId('/page'));
    const names = panel.locator('.file .name');
    await expect(names.first()).toHaveText(`${PAGE_TITLE}.zip`);
    await panel.getByRole('button', { name: 'File name' }).click();
    await expect(names).toHaveText(['report.zip', 'clip.mp4', 'paper.pdf']);
  });
});
