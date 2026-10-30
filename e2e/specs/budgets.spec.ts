import { chromium } from '@playwright/test';
import { Cdp } from '../support/cdp';
import { expect, sleep, test } from '../support/fixtures';

/**
 * The performance and memory budgets of docs/performance.md. Each number is measured here, printed, and held to its
 * budget, which has room for a slower CI machine.
 */
const BUDGETS = {
  /** Stop the background and ask it something: the time until it answers, median of five. */
  wakeMs: 250,
  /** Added to loading one frame (a navigation the listeners look at), averaged over 100 frames. */
  perNavigationMs: 10,
  /** The background's JavaScript heap with 100 tabs open. */
  heapMbWith100Tabs: 20,
  /** What the extension keeps in session storage with 100 tabs open. */
  sessionKb: 1024,
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test('the background wakes quickly', async ({ extension, profile, until }) => {
  const cdp = await Cdp.connect(profile.dir);
  const session = await cdp.attach('page', extension.url('options.html'));
  await cdp.send('ServiceWorker.enable', {}, session);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    await cdp.send('ServiceWorker.stopAllWorkers', {}, session);
    await until(
      'the background to stop',
      async () => (await cdp.targets('service_worker')).length === 0,
    );
    const started = performance.now();
    await extension.send('ext.info');
    times.push(performance.now() - started);
  }
  cdp.close();
  console.log(`wake: ${times.map((time) => Math.round(time)).join(', ')} ms`);
  expect(median(times)).toBeLessThan(BUDGETS.wakeMs);
});

test('the listeners add little to a navigation', async ({ context, extension, site }) => {
  await extension.send('ext.info');
  const plain = await chromium.launch({ channel: 'chromium', headless: true });
  const bare = await plain.newPage();
  const withExtension = await context.newPage();
  const load = async (page: typeof bare): Promise<number> => {
    const started = performance.now();
    await page.goto(`${site.origin}/frames?n=100`, { waitUntil: 'load' });
    return performance.now() - started;
  };
  await load(bare);
  await load(withExtension); // the first load warms both up
  const without: number[] = [];
  const within: number[] = [];
  for (let i = 0; i < 5; i++) {
    without.push(await load(bare));
    within.push(await load(withExtension));
  }
  await plain.close();
  const added = (median(within) - median(without)) / 100;
  console.log(
    `navigation: ${Math.round(median(without))} ms without, ${Math.round(median(within))} ms with 100 frames; ${added.toFixed(2)} ms added per frame`,
  );
  expect(added).toBeLessThan(BUDGETS.perNavigationMs);
});

test('memory stays small with 100 tabs open', async ({ context, extension, profile, site }) => {
  test.setTimeout(240_000);
  const cdp = await Cdp.connect(profile.dir);
  const worker = await cdp.attach('service_worker', `chrome-extension://`);
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage', {}, worker).catch(() => undefined);
    const { usedSize } = await cdp.send<{ usedSize: number }>('Runtime.getHeapUsage', {}, worker);
    return usedSize / 1024 / 1024;
  };
  const before = await heap();
  const pages = [];
  for (let batch = 0; batch < 10; batch++) {
    const opened = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const page = await context.newPage();
        await page.goto(`${site.origin}/page`, { waitUntil: 'load' });
        return page;
      }),
    );
    pages.push(...opened);
  }
  await sleep(2000);
  const after = await heap();
  const sessionBytes = await extension.page.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { storage: { session: { getBytesInUse(): Promise<number> } } };
      }
    ).chrome.storage.session.getBytesInUse(),
  );
  cdp.close();
  console.log(
    `memory: heap ${before.toFixed(1)} MB at start, ${after.toFixed(1)} MB with ${pages.length} tabs; session storage ${(sessionBytes / 1024).toFixed(0)} KB`,
  );
  expect(after).toBeLessThan(BUDGETS.heapMbWith100Tabs);
  expect(sessionBytes / 1024).toBeLessThan(BUDGETS.sessionKb);
});
