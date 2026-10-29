# DLM browser extension: plan

This file is the authoritative specification. Work is tracked on the
[project board](https://github.com/orgs/sabadia/projects/5); every task below is an issue. Never change this plan
to fit an implementation: if it is wrong or incomplete, say why in an issue and get a revised plan.

## Goal

An extension for Chrome and Chromium-based browsers (Edge, Brave, Opera, Vivaldi) and Firefox that makes the
browser work with [DLM](https://github.com/sabadia/dlm-app) and its daemon
[`dlm`](https://github.com/sabadia/dlm-server):

- discover and pair with the DLM app on this computer, or connect to a remote `dlm` server;
- intercept browser downloads and hand them to DLM;
- detect media and files on any page and offer them to DLM;
- pass magnet and torrent links;
- pass cookies, referrer and page address, and help refresh expired links.

## Decisions

Made with the maintainer:

- Own repository and board; the backend work is **Phase 14** in dlm-server (board #3) and the app work is
  **M9** in dlm-app (board #4).
- Distribution: **GitHub releases first, stores later** (E9 is gated on store accounts).
- Pairing: **approve in the app**; every pairing gets its own scoped, revocable token.
- Interception: **everything automatically**; files under 1 MB (adjustable) stay in the browser; per-site exclusions;
  hold Alt to bypass; optional "ask first".
- Private windows: **off unless allowed**; cookies only for the download's own domain, kept only for that task.

Made by the author of the plan:

- **WXT + TypeScript (strict) + Preact**, Manifest V3 on both browsers (Chrome service worker, Firefox event page),
  pnpm, Vitest, Playwright. Daemon types generated from the pinned OpenAPI.
- Safari and mobile browsers are out of scope. Edge, Brave, Opera and Vivaldi use the Chrome build.

## Facts the design rests on

**Browsers**

- Chrome cannot stop a download before it starts (`downloads.onCreated` only notifies): cancel and erase, then hand
  off. Firefox keeps **blocking** `webRequest` in MV3, so it can cancel before a download appears.
- Chrome MV3 `webRequest` is observe-only: enough to detect media and read headers.
- Chrome service workers suspend when idle; an open native port or messages flowing over it keep one alive.
  Firefox uses a non-persistent event page.
- Firefox needs a fixed add-on id and (new add-ons) `data_collection_permissions` (we declare `"none"`). Firefox MV3
  does not grant host permissions at install; ask during onboarding.
- Chrome's Local Network Access (Chrome 142 and later) may affect requests to `127.0.0.1` from an extension worker;
  not documented, so spike E0.5 decides. Fallback: the native host proxies requests.
- Native Messaging: per-browser, per-OS host manifest; `allowed_origins` (Chrome, exact ids) and
  `allowed_extensions` (Firefox); 1 MB host-to-browser limit; Chrome needs a stable id (manifest `key`).
- Chrome and Edge warn about developer-mode extensions for unpacked builds. **GitHub-only works well on Firefox
  (signed unlisted XPI) but is awkward on Chrome until a store listing exists.**

**The daemon today (v0.5.0)** has the native host `dev.sabadia.dlm`, `POST /v1/capture`, `/v1/tasks` and
`/v1/tasks/batch`, `/v1/resolve`, `/v1/browser/resolve`, cookie import, SSE `/v1/events`, named tokens (`admin`,
`read`) and the `extension-capture` link-refresh strategy.

**Gaps (each is a backend or app task)**

1. The extension would get the primary admin token; no pairing, no scoped or revocable token (P14.1, F9.1).
2. Firefox's `moz-extension://<uuid>` origin cannot be listed; `If-Match` is blocked and `ETag` hidden (P14.2).
3. The native-host launcher bakes in an address that goes stale because the app uses a random port (P14.3).
4. The launcher path moves with the app and is not removed on uninstall (F9.2).
5. Capture forces the direct engine, lacks checksum, mirrors, name, method, body and cookie partition key, and puts
   cookies in the global store (P14.4).
6. No format list for a quality picker; HLS and DASH are recognised only by suffix; `.torrent` limited to 1 MiB
   (P14.5, P14.7).
7. No "link refresh requested" event (P14.6).
8. No per-token rate limits (P14.8).

## Architecture

```
 content script (links, <video>, magnet clicks) ─┐
 webRequest (headers, media sniffing) ───────────┤
 downloads API (onCreated, cancel, erase) ───────┼─► background (MV3, WXT): rules, tab media store, DlmClient
 cookies API (download's own domain only) ───────┘          │
 popup / options / onboarding (Preact) ◄────────────────────┤
                                                            ▼
   local:  Native Messaging host `dlm native-host` ─ pair/connect ─► daemon on 127.0.0.1 ─ DLM app approves
   remote: URL + token (HTTPS recommended) ──────────────────────► remote `dlm` server
```

- **Targets:** one local target found through the native host plus any number of remote servers, with per-domain
  routing.
- **Pairing:** extension asks the host to pair; the daemon creates a pending pairing with a 6-digit code; the app asks
  Allow or Deny; on Allow the daemon issues an `extension`-scoped token, returned once through the host and kept in
  `storage.local` (never synced, never logged). Revocable in the app.
- **Token scope:** capture, task create/list/pause/resume, resolve, browser-resolve, cookie import, events, health,
  limits. Not allowed: settings, token management, cookie export, native-host, deleting data. Extension origins are
  accepted only with such a token.
- **Interception:** Chrome `downloads.onCreated`, rules, cancel and erase, capture. Firefox blocking
  `webRequest.onHeadersReceived`, cancel, capture. If DLM cannot take the download, restart it in the browser and say
  why. GET only in v1.
- **Metadata:** URL, final URL, page URL, referrer, mime, size, file name, user agent, selected request headers, and
  cookies for the download's own domain, in a per-task jar.
- **Media detection:** network classifier plus page scan; per-tab store drives the badge and popup; HLS and DASH
  variants parsed for a quality picker; blob and MSE pages offered through yt-dlp or the daemon's browser; DRM labelled.
- **Magnet and torrent:** user-gesture clicks are captured and sent directly; `.torrent` downloads are sent by URL.
- **Link refresh:** watch for `awaiting_link`, notify, open the stored page, capture the next matching download.

## Permissions (to justify in the store listing)

`downloads`, `webRequest`, `cookies`, `storage`, `nativeMessaging`, `contextMenus`, `notifications`, `alarms`,
`activeTab`, `scripting`, and host access to all sites (needed to see downloads, headers and cookies on any site).
No remote code, no analytics, no data leaves the computer except to the user's own DLM server.

## Order of work

1. dlm-server P14.1 to P14.3 and E0 in parallel (pairing blocks E1).
2. dlm-app F9.1 and F9.2 with E1; then E2, E3, E4; P14.4 to P14.8 as each needs them.
3. E5, E6, F9.3 and F9.4, then E7 and E8. Releases: dlm-server v0.6.0, dlm-app v0.2.0, extension v0.1.0.

## Tasks

### E0 Bootstrap and spikes

- [x] E0.1 Create the repository, board, labels and milestones — Public repo `sabadia/dlm-extension` (Apache-2.0), board #5, labels, milestones E0 to E9.
- [x] E0.2 Plan, conventions, ADRs, threat-model stub, contribution docs — `docs/PLAN.md` (authoritative), CONVENTIONS, ADR for stack and transport, threat-model stub, README, CONTRIBUTING, issue and PR templates.
- [x] E0.3 WXT + TypeScript + Preact scaffold and tooling — WXT project (MV3 for Chrome and Firefox), strict TypeScript, ESLint, Prettier, Vitest, `web-ext lint`; empty background, popup and options entries; pnpm workspace pinned (`.nvmrc`, `packageManager`).
- [ ] E0.4 CI, release workflow, licences, SBOM, Dependabot — CI: frozen install, lint, typecheck, unit tests, `web-ext lint`, build both targets, npm licence allow-list, CycloneDX SBOM, intentline. Release workflow on tag: Chrome zip, Firefox zip and sources zip, SHA256SUMS, provenance attestation, GitHub release. Dependabot for npm and actions.
- [ ] E0.5 Spike: loopback fetch from an MV3 service worker (Local Network Access) — Write down, per browser and version, whether `fetch('http://127.0.0.1:PORT')` from the background works without a prompt, with `host_permissions`, and with `targetAddressSpace`. If not, decide the fallback (native host proxies requests) and file the backend task. Result in `docs/spikes/e0-5.md`.
- [ ] E0.6 Spike: daemon origin checks with real extension requests — Run a daemon and call it from Chrome and Firefox extensions: what `Origin`, `Sec-Fetch-Site` and preflight arrive, what `CrossOriginProtection` and CORS do. Result drives P14.2. Needs backend: sabadia/dlm-server#138 (P14.2)
- [ ] E0.7 Spike: download cancel and hand-off behaviour — Chrome `downloads.onCreated` cancel+erase and Firefox blocking `webRequest`: timing, UI flash, leftover temp files, redirects, `Content-Disposition`, blob and data URLs, downloads started by other extensions. Result in `docs/spikes/e0-7.md`.
- [ ] E0.8 Spike: service-worker lifetime with a native port and SSE — How long a worker lives with `connectNative` open, with `fetch` streaming SSE, with alarms; what wakes it; what breaks. Decide how live updates and `awaiting_link` watching work.
- [ ] E0.9 Spike: fixed ids and Firefox permission model — Generate the Chrome manifest `key` (stable id) and choose the Firefox gecko id; check Firefox MV3 host-permission prompts and `data_collection_permissions`; list the minimum permission set with a justification for each. Result feeds P14.3. Needs backend: sabadia/dlm-server#139 (P14.3)

### E1 Core

- [ ] E1.1 Typed daemon client generated from the pinned OpenAPI — Generate types from a copy of the pinned OpenAPI document; small `DlmClient` (capture, tasks, resolve, events via fetch streaming, health); contract check against the newest daemon release like dlm-app's nightly job.
- [ ] E1.2 Settings schema, storage and migrations — Typed settings in `storage.local` (never synced): targets, rules, preferences; versioned migrations; import/export without secrets.
- [ ] E1.3 MV3-safe background architecture — State that survives worker restarts, typed message bus between background, popup, options and content scripts, one place that registers listeners synchronously, no globals.
- [ ] E1.4 Native messaging transport and local discovery — Connect to host `dev.sabadia.dlm`: `connect`, `ping`, live address and version; detect 'host not installed', 'app not running', 'incompatible version'. Needs backend: sabadia/dlm-server#139 (P14.3)
- [ ] E1.5 Pairing flow and token storage — Extension asks to pair, shows the code, waits for Allow/Deny in the app, stores the scoped token; re-pair after revoke; never logs the token. Needs backend: sabadia/dlm-server#137 (P14.1), sabadia/dlm-server#139 (P14.3) Needs app: sabadia/dlm-app#113 (F9.1)
- [ ] E1.6 Connection state machine, badge and version compatibility — States (not installed, not running, pairing, connected, incompatible, token revoked, remote unreachable); badge and tooltip; check `apiVersion` against `minClientApi`.
- [ ] E1.7 Remote targets (URL and token) — Add, test and remove remote servers; HTTPS recommended with a clear warning for plain HTTP and self-signed certificates (cannot be pinned from a browser).
- [ ] E1.8 Logging and diagnostics without secrets — Ring-buffer log, redaction of tokens, cookies and credentials in URLs, 'copy diagnostics'.

### E2 Interception

- [ ] E2.1 Rules engine — Per-site allow/deny, minimum size, file types and mime lists, modifier-key bypass (Alt), private-window rule, global on/off; pure functions with table tests.
- [ ] E2.2 Chrome hand-off (onCreated, cancel, erase, capture) — Intercept browser downloads, cancel and erase them, hand off to DLM; guard against re-intercepting our own fallback download. Needs the result of: E0.7
- [ ] E2.3 Firefox hand-off (blocking webRequest) — Cancel attachment and non-renderable responses before a download appears and hand off to DLM. Needs the result of: E0.7
- [ ] E2.4 Request metadata and cookies — Cache request headers per request, read cookies for the download's own domain only (Chrome partition key, Firefox container store), user agent, referrer, page URL; nothing from private windows unless allowed. Needs backend: sabadia/dlm-server#140 (P14.4)
- [ ] E2.5 Capture, fallback to the browser and feedback — Send `POST /v1/capture`; if DLM is unreachable or rejects, restart the download in the browser and say why; handle duplicates (409); badge and notification feedback. Needs backend: sabadia/dlm-server#140 (P14.4)
- [ ] E2.6 Optional 'ask first' mode — Small prompt 'Download with DLM / with the browser / always for this site'; remembered choices.

### E3 Links and menus

- [ ] E3.1 Context menus — Link, selection, image, audio, video; queue submenu; 'add paused'; 'download page with DLM'.
- [ ] E3.2 Download all links on a page — Collect links and media with filters (extension, regex, size), preview list with select-all, send via `/v1/tasks/batch`.
- [ ] E3.3 Magnet and ed2k links — Capture user clicks on `magnet:` and `ed2k:` links and send them directly (no 'open external app' prompt).
- [ ] E3.4 Torrent files — Intercept `.torrent` downloads (mime or extension) and send by URL, or as bytes when cookie-gated. Needs backend: sabadia/dlm-server#143 (P14.7)

### E4 Media detection

- [ ] E4.1 Network media classifier and per-tab store — `webRequest` response headers: content type, extension, `.m3u8`/`.mpd`, size; group segments under their manifest; ignore ads, trackers and tiny files; per-tab store with cleanup on navigation.
- [ ] E4.2 Page scan content script — `<video>`, `<audio>`, `<source>`, file links, og:video, JSON-LD VideoObject; observe DOM changes cheaply.
- [ ] E4.3 Media list in the popup and badge — Grouped list per tab with name, type, size, quality; one-click download with DLM; badge count.
- [ ] E4.4 HLS and DASH variants and quality picker — Parse master playlists and MPD in the extension; let the user choose a variant; send the chosen manifest with headers and cookies. Needs backend: sabadia/dlm-server#141 (P14.5)
- [ ] E4.5 Page modes and protected content — 'Download this page' via yt-dlp or the daemon's headless browser for blob/MSE pages; detect EME/DRM and say it cannot be downloaded. Needs backend: sabadia/dlm-server#140 (P14.4)
- [ ] E4.6 Probing and duplicate hints — Lazy `POST /v1/resolve` on popup open for name, size and duplicates. Needs backend: sabadia/dlm-server#141 (P14.5)

### E5 Popup, options and onboarding

- [ ] E5.1 Live downloads in the popup — SSE while the popup is open, progress list, pause/resume, open in DLM, queue picker, turbo toggle.
- [ ] E5.2 Options pages — Connection and targets, rules and per-site settings, interception defaults, private windows, notifications.
- [ ] E5.3 Onboarding and permissions — Step-by-step: install the app, install the native host, pair, grant access (Firefox host permissions), test download. Needs app: sabadia/dlm-app#116 (F9.4)
- [ ] E5.4 Shortcuts and settings import/export — Keyboard shortcuts via the commands API; export and import settings without secrets.
- [ ] E5.5 i18n, accessibility and theming — Message catalogue (English first), keyboard-operable and labelled UI, light and dark, high contrast and text scaling.

### E6 Refresh and advanced

- [ ] E6.1 Link refresh flow — Watch for `awaiting_link`, notify 'Link expired: open the page', open the stored page URL, capture the next matching download so the daemon refreshes the task. Needs backend: sabadia/dlm-server#142 (P14.6) Needs app: sabadia/dlm-app#115 (F9.3)
- [ ] E6.2 Checksum detection on download pages — Find SHA-256/SHA-1/MD5 values next to a download link and send them as the expected checksum (user can review). Needs backend: sabadia/dlm-server#140 (P14.4)
- [ ] E6.3 Mirrors — Detect and send mirror links from known download pages (opt-in). Needs backend: sabadia/dlm-server#140 (P14.4)
- [ ] E6.4 Multi-server routing — Per-domain routing to different targets with a default target.
- [ ] E6.5 POST downloads (stretch) — Replay small POST bodies through `source.method/body`; otherwise leave to the browser. Needs backend: sabadia/dlm-server#140 (P14.4)

### E7 Quality

- [ ] E7.1 Unit and contract tests — Rules, classifier, playlist parsing, client, storage migrations; coverage on the pure logic.
- [ ] E7.2 E2E in Chromium against a real daemon — Playwright with the built extension, fixture site (attachment, redirect, cookie-gated file, magnet page, HLS page, expiring link), real daemon fetched with a checksum; pairing approve/deny/revoke.
- [ ] E7.3 E2E in Firefox — Same scenarios through `web-ext` and geckodriver where possible; the rest in the manual checklist.
- [ ] E7.4 Performance and memory budgets — Worker wake time, per-request overhead, memory with 100 tabs; budgets and numbers in `docs/performance.md`.
- [ ] E7.5 Security review, threat model and privacy statement — Token handling, page-to-extension attacks, cookie scope, permissions justification, what is collected (nothing).
- [ ] E7.6 Manual test checklists — Per browser (Chrome, Edge, Brave, Firefox) and OS (macOS, Windows, Linux).

### E8 GitHub release

- [ ] E8.1 Release assets, signed Firefox XPI and install guide — Chrome zip (load unpacked) and Firefox XPI signed as unlisted through AMO; install guide including the Chrome developer-mode caveat. Needs from the maintainer: AMO API key
- [ ] E8.2 First release v0.1.0 and verification — Tag, release, install from the assets in Chrome and Firefox, pair with the app, intercept a real download. Needs backend: sabadia/dlm-server#137 (P14.1), sabadia/dlm-server#138 (P14.2), sabadia/dlm-server#139 (P14.3) Needs app: sabadia/dlm-app#113 (F9.1)

### E9 Stores (gated)

- [ ] E9.1 Store listings (gated) — Chrome Web Store, AMO listed, Edge Add-ons: listings, screenshots, permission justifications, privacy policy, CI publishing. Starts only when the accounts exist. Needs from the maintainer: store accounts

## Risks

- Loopback access from the Chrome worker (E0.5); fallback is the native host as a proxy.
- Cancel-then-hand-off may flash the download bar or leave a temp file (E0.7).
- Chrome install friction until a store listing exists.
- Firefox host-permission prompt; declining must leave a clear "grant access" state.
- DRM, signed expiring URLs and POST-only downloads: detect and explain, never fail silently.
- Remote servers with self-signed certificates cannot be pinned from a browser; require a trusted certificate.

## What the maintainer provides later

An AMO account and API key (signed XPI) for E8; Chrome Web Store ($5) and Edge Add-ons accounts for E9; the choice
of extra languages after English.
