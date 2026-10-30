import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import type { MessageType, RequestOf, ResponseOf } from '../../src/lib/bus/messages';
import { dlmCommand, startDaemon, type Daemon } from './daemon';
import { startSite, type Site } from './site';

/** The id the manifest key gives the extension in every Chromium browser. */
export const EXTENSION_ID = 'gfjgahdobbldpjiijaakihgmmjemdalg';
// The build under test; E2E_CHROME_DIR points at an unzipped release asset instead (docs/install.md).
const EXTENSION_DIR = path.resolve(process.env.E2E_CHROME_DIR ?? '.output/chrome-mv3');

export interface Extension {
  /** Sends a message to the background, as an extension page does, and returns what it answered. */
  send<T extends MessageType>(
    type: T,
    ...payload: RequestOf<T> extends undefined ? [] : [RequestOf<T>]
  ): Promise<ResponseOf<T>>;
  /** An extension page, opened and kept for `send`. */
  page: Page;
  url(file: string): string;
  /** Pairs with the daemon the way a person does: start, compare the code, allow it in the app. */
  pair(): Promise<void>;
  /** The id of the open tab whose address contains `part`. */
  tabId(part: string): Promise<number>;
  /** Opens the Files panel as a page, about the given tab (the real panel follows the active tab). */
  filesPanel(tabId: number): Promise<Page>;
}

interface World {
  profile: Profile;
  daemon: Daemon;
  site: Site;
  context: BrowserContext;
  extension: Extension;
  /** Waits until `check` returns a value that is not `undefined`/`false`. */
  until<T>(
    what: string,
    check: () => Promise<T | undefined | false> | T | undefined | false,
    ms?: number,
  ): Promise<T>;
}

export interface Profile {
  /** The browser profile directory (holds `DevToolsActivePort`). */
  dir: string;
}

export interface Pairing {
  id: string;
  code: string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const test = base.extend<World>({
  site: async ({}, use) => {
    const site = await startSite();
    await use(site);
    await site.stop();
  },

  daemon: async ({}, use) => {
    const home = mkdtempSync(path.join(tmpdir(), 'dlm-e2e-daemon-'));
    const daemon = await startDaemon(home, `chrome-extension://${EXTENSION_ID}`);
    await use(daemon);
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  },

  profile: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dlm-e2e-profile-'));
    await use({ dir });
    rmSync(dir, { recursive: true, force: true });
  },

  context: async ({ daemon, profile: where }, use) => {
    const profile = where.dir;
    mkdirSync(path.join(profile, 'Default'), { recursive: true });
    const downloads = path.join(profile, 'browser-downloads');
    mkdirSync(downloads);
    writeFileSync(
      path.join(profile, 'Default', 'Preferences'),
      JSON.stringify({
        download: { default_directory: downloads, prompt_for_download: false },
        savefile: { default_directory: downloads },
      }),
    );
    // The way the DLM app installs its host for a browser: a manifest that names the extension, and a launcher.
    const hosts = path.join(profile, 'NativeMessagingHosts');
    mkdirSync(hosts);
    const launcher = path.join(hosts, 'dlm-host.sh');
    writeFileSync(
      launcher,
      `#!/bin/sh\nexport DLM_SERVER_ALLOWED_ORIGINS=chrome-extension://${EXTENSION_ID}\nexec ${dlmCommand()} native-host --home ${daemon.home} --server ${daemon.url} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    writeFileSync(
      path.join(hosts, 'dev.sabadia.dlm.json'),
      JSON.stringify({
        name: 'dev.sabadia.dlm',
        description: 'DLM (end-to-end test)',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      }),
    );
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      acceptDownloads: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--no-first-run',
        '--remote-debugging-port=0',
      ],
    });
    await use(context);
    await context.close();
  },

  extension: async ({ context, daemon, until }, use) => {
    // The background must be running before anything is sent to it.
    if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = (file: string) => `chrome-extension://${EXTENSION_ID}/${file}`;
    await page.goto(url('options.html'));
    const send: Extension['send'] = async (type, ...payload) => {
      const reply = await page.evaluate(
        ({ type: kind, body }) =>
          (
            globalThis as unknown as {
              chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
            }
          ).chrome.runtime.sendMessage({ dlm: 1, type: kind, payload: body }),
        { type, body: payload[0] },
      );
      const answer = reply as { ok: true; value: never } | { ok: false; error: string } | undefined;
      if (!answer) throw new Error(`no answer to ${type}`);
      if (!answer.ok) throw new Error(`${type}: ${answer.error}`);
      return answer.value;
    };
    const extension = { page, url, send } as Extension;
    extension.pair = async () => {
      const started = await extension.send('pairing.start');
      const code = started.phase === 'pending' ? started.code : '';
      const found = await until('the pairing in the daemon', async () => {
        const list = await daemon.api<Pairing[] | { pairings: Pairing[] }>('GET', '/v1/pairing');
        return (Array.isArray(list) ? list : list.pairings).find((item) => item.code === code);
      });
      await daemon.api('POST', `/v1/pairing/${found.id}/approve`);
      await until(
        'an approved pairing',
        async () => (await extension.send('pairing.poll')).phase === 'approved',
      );
      await until(
        'a connection',
        async () => (await extension.send('connection.refresh')).state.kind === 'connected',
      );
    };
    extension.tabId = async (part) =>
      until('the tab', async () => {
        const tabs = await page.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: { tabs: { query(q: object): Promise<{ id: number; url?: string }[]> } };
            }
          ).chrome.tabs.query({}),
        );
        return tabs.find((tab) => tab.url?.includes(part))?.id;
      });
    extension.filesPanel = async (tabId) => {
      const panel = await context.newPage();
      await panel.goto(url(`sidepanel.html?tab=${tabId}`));
      return panel;
    };
    await use(extension);
  },

  until: async ({}, use) => {
    await use(async (what, check, ms = 15_000) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await check();
        if (value !== undefined && value !== false) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(150);
      }
    });
  },
});

export { expect } from '@playwright/test';
