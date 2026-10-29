# Engineering conventions

## Toolchain

- Node and pnpm are pinned (`.nvmrc`, `packageManager`); CI uses the same. Bumping a pin is its own pull request.
- Before adding a dependency check its licence (MIT, BSD, Apache-2.0, MPL-2.0, ISC only), its maintenance and that it
  runs in a service worker or event page. Prefer none: the extension is small.

## TypeScript

- `strict` plus `noUncheckedIndexedAccess`; no `any` outside the generated client's edge; no non-null `!` on values
  that can legitimately be missing.
- Pure logic (rules, classifier, playlist parsing, redaction) is in plain functions with table tests and no browser
  APIs; browser APIs are wrapped behind small interfaces so tests can fake them.
- Lint and format are enforced; do not silence a rule without a comment saying why.

## Extension rules

- **Manifest V3 everywhere.** All listeners are registered synchronously at the top level of the background entry. The
  background keeps no state in memory that matters: it lives in `storage.session` or `storage.local` and survives a
  restart of the worker.
- **Secrets.** Tokens live only in `storage.local` (never `sync`), are never logged, never put in a URL, never sent to
  a content script or page. Errors shown to the user and written to the log pass through the redactor.
- **Pages are untrusted.** Content scripts only report what they saw; they cannot ask the background to do anything
  that a user gesture did not cause. The background validates the sender of every message (extension id, frame, tab).
- **Least data.** Cookies are read for the download's own domain only, never in a private window unless the user
  allowed it, and are sent to a per-task jar. Headers sent are an allow-list.
- **Permissions** are the smallest set that works, each justified in `docs/PLAN.md`; a new one is a plan change.
- **No remote code**, no `eval`, no analytics, no network except to the user's DLM targets.
- **Both browsers.** Use the `browser` namespace through WXT; anything Chrome-only or Firefox-only is isolated in one
  adapter file and listed in `docs/browser-differences.md`.

## UI

- Preact, small components, no business logic in render. Every string is in the message catalogue.
- Everything is keyboard operable and labelled; respects light and dark, high contrast and text scaling.

## Testing

- Vitest for logic; Playwright for the real extension in Chromium against a real daemon and a local fixture site;
  Firefox through `web-ext` where possible. No network except to the fixture and the local daemon.
- A bug fix comes with the test that failed.

## Git

- Conventional Commits; squash merge; one phase per branch and pull request; commits end with the attribution lines.
