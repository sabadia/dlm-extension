# Manual test checklists

What the automated tests cannot do (docs/PLAN.md, E7.6). The end-to-end tests (`pnpm e2e`) cover pairing, taking over a
download, the Files panel, cookies, magnet links, streams and expired links in **Chromium** and **Firefox** against a real
daemon; what is left is below. Run the list for a release, in each browser and system you claim to support, with a build
from `pnpm build` (or `pnpm build:firefox`) loaded unpacked (Chrome: `chrome://extensions`, Developer mode, Load unpacked,
`.output/chrome-mv3`; Firefox: `about:debugging`, This Firefox, Load Temporary Add-on, `.output/firefox-mv3/manifest.json`).

Mark each box with the date and who ran it. A failure is an issue before it is anything else.

To test a release instead of a build, point the end-to-end tests at its assets: unzip `dlm-extension-<version>-chrome.zip`
and run `E2E_CHROME_DIR=<folder> E2E_FIREFOX_ADDON=<file>.xpi pnpm exec playwright test` (the signed `.xpi` is then
installed with Firefox's signature check). v0.1.0 passed all 17 tests this way.

## Matrix

|         | macOS | Windows | Linux |
| ------- | ----- | ------- | ----- |
| Chrome  | [ ]   | [ ]     | [ ]   |
| Edge    | [ ]   | [ ]     | [ ]   |
| Brave   | [ ]   | [ ]     | [ ]   |
| Firefox | [ ]   | [ ]     | [ ]   |

Chrome and Edge and Brave share one build; check Brave with Shields up and down in section 2. Safari and mobile browsers are not
supported.

## 1. Install and pair (the native host is the DLM app's, so only a person can test it)

- [ ] In the DLM app, Manage, Access, Install for this browser. The browser is listed as installed.
- [ ] Open the extension's options. "Get started" shows the first steps done as they are done.
- [ ] Connect: a six-digit code shows in the extension and in the app; they are the same. Allow in the app. The options say
      connected and "Send a test download" creates a task in the app.
- [ ] Deny in the app: the extension says it was refused. Cancel in the extension: the request disappears from the app.
- [ ] Revoke the extension's token in the app: within a minute the options say the token was revoked and offer pairing again.
- [ ] Quit the DLM app: the extension says DLM is not running (not an error page); start it again: it reconnects by itself.
- [ ] Firefox: grant "access to all sites" when asked; downloads before that are left in the browser, and the options say why.

## 2. Taking over downloads

- [ ] A link to a large file (a `.zip` or `.iso` over the minimum size) is taken by DLM; no file appears in the browser's
      folder and no entry stays in the downloads list.
- [ ] Holding Alt (or the key chosen in the options) while clicking keeps that one in the browser.
- [ ] A site in "Sites to leave in the browser" is left alone; a site in "Sites to always take" is taken even if small.
- [ ] "Ask before sending" shows the prompt with the file's name and site; each choice does what it says.
- [ ] A download behind a sign-in (log in, then click a download) is saved by DLM with its right size.
- [ ] A download from a private window is left alone until "Also take downloads from private windows" is on; then it uses that
      window's cookies (log in only in the private window to check).
- [ ] Firefox container tab: a download from a container uses that container's cookies.
- [ ] A `blob:` download (a "save" button of a web app) stays in the browser.
- [ ] The badge and the notification show what happened, and a failed hand-off falls back to the browser.

## 3. The Files panel

- [ ] The toolbar button opens the **side panel** (Chrome) or **sidebar** (Firefox) and it follows the tab you switch to.
- [ ] Settings, Files panel, "Open the Files list as: Popup" makes the button open a popup instead; back to Side panel.
- [ ] On a page with several files: only real files are listed, each with a size, the largest first; a link that redirects
      to a file is listed once with the file's size.
- [ ] Names are the page title plus the extension; "File name" shows the file's own names; click a name to rename it.
- [ ] Download, Download with DLM's browser, Copy link, select several and "Download N" (with a queue, with "Add paused").
- [ ] "Send this site's cookies to DLM": the confirmation names the site and the count; the cookies are then in the app.
- [ ] A page with a video stream (HLS or DASH) shows a Stream row with a quality choice.
- [ ] Alt+Shift+D opens the panel. With nothing to list the panel says so; on `chrome://` pages it says it cannot look.
- [ ] Dark mode, high contrast (Windows) and a 200 % zoom still read well.

## 4. Menus, links, media

- [ ] Right-click a link, an image, a video, a selection of text with a link and a page: "Send to DLM" and each queue work;
      "add paused" is respected.
- [ ] "Send all links on this page" opens the preview; the filters narrow it; "Send" creates the tasks.
- [ ] A magnet link and an eD2K link on a page go to DLM on a click (not before one).
- [ ] A page with a download page checksum and mirrors: with "Send mirror links" on, the review shows them first.

## 5. Expired links and servers

- [ ] A download whose link expired (use a short-lived link) shows a notification; clicking it opens the page; downloading
      again there renews the same task.
- [ ] A second DLM server on another computer: added with its address and token, tested, made active; a site routed to it
      sends its downloads there; `http://` shows the warning.
- [ ] Export the settings, change some, import the file: the settings are back, a server added from a file has no token.

## 6. Other

- [ ] The options page at a narrow width (phone-like) and at 200 % zoom; keyboard only (Tab, Enter, Space, Esc) reaches
      everything; a screen reader names the buttons and the switches.
- [ ] "Copy diagnostics" holds no token, cookie or full query string.
- [ ] Uninstall removes the extension and leaves nothing in the browser (the app keeps its tasks).
- [ ] Windows: the native host works with a user name that has spaces or non-Latin letters; Linux: from a Flatpak or Snap
      browser, note whether the app can install the host, and what the extension tells the person when it cannot.
