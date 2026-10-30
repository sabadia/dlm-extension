import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: the built extension (`pnpm build`) in Chromium, a real `dlm serve` (`DLM=/path/to/dlm`, default
 * `dlm` on the PATH), and a fixture website. They run one at a time, each with its own browser profile and daemon.
 */
export default defineConfig({
  testDir: 'e2e/specs',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' },
});
