import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures';
import { FILES, PAGE_TITLE, body, sha256 } from '../support/site';

test('the Files panel lists only real files, named after the page, and sends one to DLM', async ({
  context,
  daemon,
  extension,
  site,
  until,
}) => {
  await extension.pair();
  const page = await context.newPage();
  await page.goto(`${site.origin}/page`);
  const panel = await extension.filesPanel(await extension.tabId('/page'));

  const rows = panel.locator('.file');
  await expect(rows).toHaveCount(3); // the report, the video, and the paper behind two redirects
  // Largest first, each with its size, named after the page's title and the file's own extension.
  await expect(rows.locator('.name')).toHaveText([
    `${PAGE_TITLE}.zip`,
    `${PAGE_TITLE}.mp4`,
    `${PAGE_TITLE}.pdf`,
  ]);
  const meta = await rows.locator('.meta').allTextContents();
  expect(meta.map((text) => text.split(' · ')[0]?.trim())).toEqual(['600 KB', '500 KB', '300 KB']);
  // Links that are not downloads are never asked for.
  // A link that looks like a download but is a web page is checked and left out; a link that does not is not asked for.
  expect(site.seen.filter((line) => line.endsWith('/logout'))).toEqual([]);
  await expect(rows.filter({ hasText: 'archive' })).toHaveCount(0);

  // Download the paper: the link redirects twice, DLM gets the file's own address and the title as the name.
  await rows.filter({ hasText: '.pdf' }).locator('.dl').click();
  const task = await until('the task in DLM', async () => {
    const list = await daemon.api<{ tasks?: Task[] } | Task[]>('GET', '/v1/tasks');
    const tasks = Array.isArray(list) ? list : (list.tasks ?? []);
    return tasks.find((item) => item.name === `${PAGE_TITLE}.pdf`);
  });
  expect(task.source.currentUrl).toBe(`${site.origin}${FILES.paper.path}`);
  const done = await until('the file', () => {
    const path = join(daemon.downloads, task.name);
    return existsSync(path) ? readFileSync(path) : false;
  });
  expect(sha256(done)).toBe(sha256(body('paper', FILES.paper.size)));
});

interface Task {
  id: string;
  name: string;
  status: string;
  source: { currentUrl: string };
}
