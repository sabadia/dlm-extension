import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures';
import { body, sha256 } from '../support/site';

interface Task {
  id: string;
  name: string;
  status: string;
}

test('a link that expired is renewed from its page and the download carries on', async ({
  context,
  daemon,
  extension,
  site,
  until,
}) => {
  test.setTimeout(120_000);
  await extension.pair();
  const settings = await extension.send('settings.get');
  await extension.send('settings.save', {
    rules: { ...settings.rules, minSizeBytes: 0 },
    preferences: settings.preferences,
    routes: settings.routes,
    files: settings.files,
  });

  // A download whose link has already expired: DLM cannot fetch it, and waits for the browser to capture it again.
  site.expire();
  const { task: created } = await daemon.api<{ task: Task }>('POST', '/v1/capture', {
    url: `${site.origin}/expiring/file.zip`,
    pageUrl: `${site.origin}/expiring-page`,
    filename: 'expiring.zip',
  });
  await until('a task waiting for a link', async () => {
    const task = await daemon.api<Task>('GET', `/v1/tasks/${created.id}`);
    return task.status === 'awaiting_link' || false;
  });

  // The extension notices (its alarm runs every half minute), and the next download from that page renews it.
  site.renew();
  const page = await context.newPage();
  await page.goto(`${site.origin}/expiring-page`);
  await until(
    'the extension to know a link is waiting',
    async () => {
      // The page is remembered by the extension once its scan has seen the waiting task.
      const waiting = await extension.page.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: { storage: { session: { get(key: null): Promise<Record<string, unknown>> } } };
          }
        ).chrome.storage.session.get(null),
      );
      return JSON.stringify(waiting).includes('expiring-page') || false;
    },
    45_000,
  );
  await page.click('#fresh');

  const done = await until(
    'the renewed task to finish',
    async () => {
      const task = await daemon.api<Task>('GET', `/v1/tasks/${created.id}`);
      return task.status === 'completed' ? task : false;
    },
    30_000,
  );
  const file = join(daemon.downloads, done.name);
  expect(existsSync(file)).toBe(true);
  expect(sha256(readFileSync(file))).toBe(sha256(body('expiring', 400_000)));
});
