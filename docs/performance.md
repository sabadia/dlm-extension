# Performance and memory budgets

The extension should be invisible when nothing is downloaded. These budgets are held by
`e2e/specs/budgets.spec.ts`, which runs with the end-to-end tests (Chromium, the built extension, a real DLM daemon).
Each test measures, prints the number and fails when it passes its budget. A budget is several times the number
measured on a development machine, so that a slower CI machine does not fail it, and a real regression does.

| What                                                | How it is measured                                                                                                          | Budget  | Measured (Apple silicon, Chromium 156) |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------- |
| Background wake time                                | Stop the service worker (DevTools `ServiceWorker.stopAllWorkers`, checked), send a message, time the answer. Median of five | 250 ms  | 9 to 29 ms                             |
| Added to a navigation by the `webRequest` listeners | Load a page of 100 frames with and without the extension (median of five loads), divide the difference by 100               | 10 ms   | 2.5 ms per frame                       |
| Background JavaScript heap with 100 tabs open       | `Runtime.getHeapUsage` after a garbage collection, 100 tabs of a page with links and a video                                | 20 MB   | 0.9 MB at start, 1.3 MB with 100 tabs  |
| Session storage with 100 tabs open                  | `storage.session.getBytesInUse`                                                                                             | 1024 KB | about 120 KB                           |

## Why these numbers are small

- **Listeners are narrow.** `webRequest` listens to `main_frame`, `sub_frame` and `other` only, never images, scripts or
  XHR; the rules are evaluated only for a response that looks like a download (docs/CONVENTIONS.md).
- **No state in memory that a restart would lose.** Observations, tab media and hints live in `storage.session` with caps
  (per tab, per list, per message); the worker holds almost nothing, so waking it costs a few milliseconds.
- **Nothing runs while idle.** The content script scans a page once and again when it changes (bounded), the Files panel
  checks files only while it is open, and the only alarms are the connection check (a minute) and the expired-link check
  (half a minute, Chrome's shortest).

## Running them

```sh
pnpm build
DLM=/path/to/dlm pnpm exec playwright test budgets
```

Firefox is not measured: its background is an event page and there is no equivalent of the DevTools service-worker
controls in the test setup. The manual checklist (docs/manual-tests.md) asks for a look at `about:memory` and
`about:performance` instead.
