import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { By } from 'selenium-webdriver';
import { test, expect } from '../support/firefox';
import { FILES, PAGE_TITLE, body, sha256 } from '../support/site';

interface Task {
  id: string;
  name: string;
  status: string;
  source: { currentUrl: string };
}

const tasksOf = async (api: <T>(method: string, path: string) => Promise<T>): Promise<Task[]> => {
  const list = await api<{ tasks?: Task[] }>('GET', '/v1/tasks');
  return list.tasks ?? [];
};

/**
 * The pairing needs the native host, which the DLM app installs in the person's own Firefox folder: it is on the manual
 * list (docs/manual-tests.md). Here DLM is added as a server with its token, which the extension treats the same way
 * from then on.
 */
test.describe('Firefox with DLM added as a server', () => {
  test.beforeEach(async ({ firefox, daemon, until }) => {
    const added = await firefox.send('remote.add', {
      name: 'Test DLM',
      url: daemon.url,
      token: daemon.token,
    });
    expect(added.ok).toBe(true);
    const target = (await firefox.send('remote.list')).find((item) => item.kind === 'remote');
    await firefox.send('remote.setActive', { id: target?.id ?? '' });
    await until(
      'a connection',
      async () => (await firefox.send('connection.refresh')).state.kind === 'connected',
    );
    const settings = await firefox.send('settings.get');
    await firefox.send('settings.save', {
      rules: { ...settings.rules, minSizeBytes: 0 },
      preferences: settings.preferences,
      routes: settings.routes,
      files: settings.files,
    });
  });

  test('a download the browser starts is taken over before a download entry appears', async ({
    firefox,
    daemon,
    site,
    until,
  }) => {
    await firefox.openPage(`${site.origin}/attachments`);
    await firefox.driver.findElement(By.id('export')).click();
    const task = await until('the task in DLM', async () =>
      (await tasksOf(daemon.api)).find((item) => item.name === 'export_final_v2.bin'),
    );
    expect(task.source.currentUrl).toBe(`${site.origin}${FILES.attachment.path}`);
  });

  test('the Files panel lists the real files, named after the page, and sends one to DLM', async ({
    firefox,
    daemon,
    site,
    until,
  }) => {
    await firefox.openPage(`${site.origin}/page`);
    const pageTab = await firefox.tabId('/page');
    await firefox.openExtensionPage(`sidepanel.html?tab=${pageTab}`);
    const names = await until('the files', async () => {
      const rows = await firefox.driver.findElements(By.css('.file .name'));
      const texts = await Promise.all(rows.map((row) => row.getText()));
      return texts.length === 3 ? texts : false;
    });
    expect(names).toEqual([`${PAGE_TITLE}.zip`, `${PAGE_TITLE}.mp4`, `${PAGE_TITLE}.pdf`]);
    const buttons = await firefox.driver.findElements(By.css('.file .dl'));
    await buttons[2]?.click();
    const task = await until('the task in DLM', async () =>
      (await tasksOf(daemon.api)).find((item) => item.name === `${PAGE_TITLE}.pdf`),
    );
    expect(task.source.currentUrl).toBe(`${site.origin}${FILES.paper.path}`);
  });

  test('a magnet link on a page goes to DLM', async ({ firefox, daemon, site, until }) => {
    await firefox.openPage(`${site.origin}/magnets`);
    await firefox.driver.findElement(By.id('magnet')).click();
    const task = await until('the magnet task', async () =>
      (await tasksOf(daemon.api)).find((item) => item.source.currentUrl.startsWith('magnet:')),
    );
    expect(task.source.currentUrl).toContain('0123456789abcdef0123456789abcdef01234567');
  });

  test('a file behind a sign-in is downloaded with the browser’s cookies', async ({
    firefox,
    daemon,
    site,
    until,
  }) => {
    await firefox.openPage(`${site.origin}/members`);
    await firefox.driver.manage().addCookie({ name: 'sid', value: 'ok' });
    await firefox.driver.navigate().refresh();
    const pageTab = await firefox.tabId('/members');
    await firefox.openExtensionPage(`sidepanel.html?tab=${pageTab}`);
    await until(
      'the file',
      async () => (await firefox.driver.findElements(By.css('.file .dl'))).length === 1,
    );
    await (await firefox.driver.findElement(By.css('.file .dl'))).click();
    const task = await until('the task in DLM', async () =>
      (await tasksOf(daemon.api)).find((item) => item.source.currentUrl.endsWith(FILES.gated.path)),
    );
    const bytes = await until('the file', () => {
      const file = join(daemon.downloads, task.name);
      return existsSync(file) ? readFileSync(file) : false;
    });
    expect(sha256(bytes)).toBe(sha256(body('gated', FILES.gated.size)));
  });
});
