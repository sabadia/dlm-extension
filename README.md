# DLM browser extension

Send downloads, videos, magnet links and torrents from your browser to [DLM](https://github.com/sabadia/dlm-app).

Works with Chrome and Chromium-based browsers (Edge, Brave, Opera, Vivaldi) and Firefox.

> **Status:** planning and bootstrap. Nothing is released yet. The plan is [docs/PLAN.md](docs/PLAN.md); progress is on
> the [project board](https://github.com/orgs/sabadia/projects/5).

## What it will do

- **Pairs with DLM.** Finds the DLM app on your computer and asks you to approve it in the app (or connects to a
  remote `dlm` server with a URL and token).
- **Takes over downloads.** Downloads that start in the browser go to DLM instead, unless the file is small, the site
  is excluded, or you hold Alt.
- **Finds media and files** on any page and lets you download them with DLM, with a quality choice for streams.
- **Handles magnet and torrent links** without the browser's "open external app" prompt.
- **Passes what DLM needs:** cookies for that site only, the page address, the referrer, and a fresh link when an old
  one expired.
- **Stays private.** No analytics. Nothing leaves your computer except to your own DLM server.

## Developing

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm dev            # Chrome, with hot reload
pnpm dev:firefox
pnpm test           # unit tests (pnpm test:coverage adds the coverage thresholds)
pnpm e2e            # end-to-end tests in Chromium and Firefox against a real `dlm` (set DLM=/path/to/dlm)
pnpm build          # both browsers into .output/
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Related

- [dlm-app](https://github.com/sabadia/dlm-app): the desktop app
- [dlm-server](https://github.com/sabadia/dlm-server): the `dlm` daemon and CLI

Licensed under [Apache-2.0](LICENSE).
