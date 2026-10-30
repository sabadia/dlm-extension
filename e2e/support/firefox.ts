import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Builder, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import type { MessageType, RequestOf, ResponseOf } from '../../src/lib/bus/messages';
import { test as base } from './fixtures';

/** The address the extension page of the test browser has: set below, so the page can be opened by address. */
const UUID = '11111111-2222-4333-8444-555555555555';
const BUILD = path.resolve('.output/firefox-mv3');

export interface Firefox {
  driver: WebDriver;
  /** An extension page in its own tab, kept for `send`. */
  extensionHandle: string;
  send<T extends MessageType>(
    type: T,
    ...payload: RequestOf<T> extends undefined ? [] : [RequestOf<T>]
  ): Promise<ResponseOf<T>>;
  /** Opens an extension page in a new tab and returns its window handle. */
  openExtensionPage(file: string): Promise<string>;
  /** Opens a web page in a new tab (the extension page keeps its own). */
  openPage(url: string): Promise<void>;
  /** The id of the open tab whose address contains `part`. */
  tabId(part: string): Promise<number>;
}

async function openExtensionPage(webdriver: WebDriver, file: string): Promise<string> {
  const driver = webdriver as firefox.Driver;
  const before = await driver.getAllWindowHandles();
  // The driver may not navigate to a moz-extension address, but the browser's own scope may open a tab.
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `gBrowser.selectedTab = gBrowser.addTab('moz-extension://${UUID}/${file}', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
  );
  await driver.setContext(firefox.Context.CONTENT);
  for (let i = 0; i < 50; i++) {
    const now = await driver.getAllWindowHandles();
    const fresh = now.find((handle) => !before.includes(handle));
    if (fresh) {
      await driver.switchTo().window(fresh);
      return fresh;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the extension page ${file} did not open`);
}

export const test = base.extend<{ firefox: Firefox }>({
  firefox: async ({}, use) => {
    const manifest = JSON.parse(readFileSync(path.join(BUILD, 'manifest.json'), 'utf8')) as {
      browser_specific_settings: { gecko: { id: string } };
    };
    const downloads = mkdtempSync(path.join(tmpdir(), 'dlm-e2e-firefox-downloads-'));
    const options = new firefox.Options();
    options.addArguments('-headless');
    options.setPreference(
      'extensions.webextensions.uuids',
      JSON.stringify({ [manifest.browser_specific_settings.gecko.id]: UUID }),
    );
    // Downloads that the extension leaves in the browser go to a temporary folder, never to the person's own.
    options.setPreference('browser.download.folderList', 2);
    options.setPreference('browser.download.dir', downloads);
    options.setPreference(
      'browser.helperApps.neverAsk.saveToDisk',
      'application/octet-stream,application/zip',
    );
    const driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
      .build();
    const installer = driver as unknown as {
      installAddon(dir: string, temporary: boolean): Promise<string>;
    };
    await installer.installAddon(BUILD, true);
    const extensionHandle = await openExtensionPage(driver, 'options.html');
    const send: Firefox['send'] = async (type, ...payload) => {
      await driver.switchTo().window(extensionHandle);
      const reply = await driver.executeAsyncScript<
        { ok: true; value: never } | { ok: false; error: string } | undefined
      >(
        `const done = arguments[arguments.length - 1];
         browser.runtime.sendMessage({ dlm: 1, type: arguments[0], payload: arguments[1] }).then(done, (e) => done({ ok: false, error: String(e) }));`,
        type,
        payload[0],
      );
      if (!reply) throw new Error(`no answer to ${type}`);
      if (!reply.ok) throw new Error(`${type}: ${reply.error}`);
      return reply.value;
    };
    const tabId: Firefox['tabId'] = async (part) => {
      await driver.switchTo().window(extensionHandle);
      for (let i = 0; i < 50; i++) {
        const id = await driver.executeAsyncScript<number | undefined>(
          `const done = arguments[arguments.length - 1];
           browser.tabs.query({}).then((tabs) => done((tabs.find((t) => (t.url || '').includes(arguments[0])) || {}).id), () => done(undefined));`,
          part,
        );
        if (id !== undefined) return id;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`no tab with ${part}`);
    };
    await use({
      driver,
      extensionHandle,
      send,
      tabId,
      openExtensionPage: (file) => openExtensionPage(driver, file),
      openPage: async (url) => {
        await driver.switchTo().newWindow('tab');
        await driver.get(url);
      },
    });
    await driver.quit();
    rmSync(downloads, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
