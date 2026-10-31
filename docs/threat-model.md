# Threat model (reviewed in E7.5)

## Assets

- The scoped token for the user's DLM server (and tokens for remote servers).
- Cookies, request headers and URLs of downloads the user hands to DLM.
- The user's browsing context (which pages have media, which downloads happen).

## Trust

- The extension's own code and the DLM daemon the user paired with are trusted.
- Web pages are **not** trusted; neither are other extensions or other local processes.

## Threats to answer (each gets a mitigation and a test)

1. A page makes the extension send a download or a cookie somewhere (content-script messages need a user gesture; the
   background validates the sender; destinations are only the user's targets).
2. A page or another extension reads the token (storage is extension-private; never sent to content scripts).
3. A malicious local process pairs as the extension (pairing needs approval in the app with a code the user compares).
4. A leaked token floods or damages the daemon (scoped token, per-token rate limits, revocable in the app).
5. Cookies leak across sites or from private windows (own domain only, per-task jar, private windows off by default).
6. A downloaded file name or URL tricks a log, a notification or a path (sanitised; the daemon chooses paths).
7. A remote server impersonates the user's server (HTTPS with a trusted certificate recommended; warn on plain HTTP;
   pinning is not possible from a browser).

## How E2 to E6 answer them (reviewed)

- **Messages from pages (1).** Content-script handlers are opt-in (`fromContent`), accept only the top frame (media, links,
  hints; an iframe may only say that it plays protected media), take the page address from the sender and never from the
  message, check and cap the payload, and take a magnet or eD2K link only from a real click (`isTrusted`, main button),
  at most five a few seconds per tab. A link DLM does not accept goes back to the browser.
- **Checksums and mirrors from pages (1).** A hint belongs to the origin of the page that reported it and is used only for a
  download that started on that page; mirrors and checksums are shown for review before they are sent, and mirrors are off
  until the person turns them on.
- **Settings import (2).** A file cannot re-point a known server at another address and keep its token: a changed or new server
  gets a new id and no token, is not active, and no route may use it. Tokens of servers that are gone are deleted.
- **Tokens in memory and storage (2).** Request headers (allow-listed, `Authorization` among them) are held in memory only
  for a few seconds and are dropped for requests of the extension itself; session storage holds observations of download
  candidates only. `Authorization` is not repeated on a redirect to another origin.
- **Private windows (5).** No cookies unless the person allowed private windows; then those of that window's own store (Chrome:
  found through the tab; Firefox: the request's store), and a restarted download stays in that window or container.
- **Files panel checks and cookies (E5b).** The panel asks the page's own servers for a file's size (HEAD, or a one-byte ranged GET),
  with the person's cookies, only for links that look like downloads (a file extension, the `download` attribute, download wording),
  never for every link, so a link such as `/logout` is not requested. Sending a site's cookies to DLM is a click, after a
  confirmation naming the site and the count; only that site's cookies (and its parent domains) go, never from a private window
  unless private windows are allowed, to the DLM the person chose. DLM keeps them until they are removed in the app; the extension's
  token cannot delete them.
- **Rate limits (4).** Per-token limits are the daemon's (P14.8); the extension adds none for downloads, a limit per tab for
  magnet links, and caps on every list it sends.
- **Remote servers (7).** Unchanged; `http://` to another computer is warned about before and after adding it.

## Review of phase E7 (2026-10-30)

A review of the whole extension against the seven threats above, with a second pass over the Files panel and the cookie
sending added in E5b. Nothing rated high was found. What was found, and what was done:

| #   | Finding                                                                                                                                                                                                        | Rating | Outcome                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | A hostile page could make the Files panel request any address it names (the panel checks links that look like downloads), with the person's cookies, including addresses on this computer or the local network | medium | **Fixed.** `src/lib/files/policy.ts`: cookies go only to the page's own site (host, parent or sub domain); addresses on this computer or the local network are checked only when the page itself is there. Tested                                                           |
| F2  | The panel checked links from a private window with the cookies of the normal profile                                                                                                                           | medium | **Fixed.** A private window's links are checked without cookies                                                                                                                                                                                                             |
| F3  | A real click on a magnet or eD2K link a page dressed up as something else queues it, not paused                                                                                                                | low    | Accepted: the click is real (`isTrusted`), five per ten seconds per tab, and the person sees the task in the app and can delete it                                                                                                                                          |
| F4  | The cookie confirmation could name another tab than the one whose cookies were sent, if the active tab changed while it was open                                                                               | low    | **Fixed.** What was previewed is what is sent                                                                                                                                                                                                                               |
| F5  | Right-to-left overrides and zero-width characters in a file name could change how a name reads in a prompt or notification                                                                                     | low    | **Fixed.** Removed from every name (`sanitizeFileName`, and the names of downloads taken over)                                                                                                                                                                              |
| F6  | No limit on how many browser downloads a page can start in a row                                                                                                                                               | low    | Accepted: each is a normal download decision of the rules (or an ask prompt); the daemon's per-token limits (P14.8) bound the damage, and a flood is visible in the app                                                                                                     |
| F7  | The tokens sit in `storage.local`, which Chrome lets content scripts read unless the extension closes it                                                                                                       | info   | **Fixed.** `storage.local.setAccessLevel('TRUSTED_CONTEXTS')` at start (Chrome); no content script of ours reads it anyway. Firefox has no such setting and its content scripts can reach the area, so there the protection is only that no content script of ours reads it |
| F8  | The token is sent to the address the native host reports, with no check that it is loopback                                                                                                                    | info   | Accepted: the native host is trusted, and a manifest that points at it is written by the DLM app. Remote servers have their own warning                                                                                                                                     |
| F9  | A settings file can switch privacy-relevant options (`privateWindows`, mirrors)                                                                                                                                | info   | Accepted: an import replaces the settings on purpose and a new server never keeps a token. Worth a review step in a later release                                                                                                                                           |

How the seven threats stand after the review:

1. **A page makes the extension send something (mitigated).** Only five handlers take a message from a content script
   (`gesture.note`, `page.hints`, `links.add`, `media.scan`, `media.protected`); each checks and caps its payload, takes the
   page address from the sender, accepts the top frame only, and acts only on real input.
2. **The token is read (mitigated).** It is in the secret store only, set only in the `Authorization` header, and is in no
   message to a content script, no log, no diagnostics text. The token input is a password field.
3. **A local process pairs as the extension (mitigated in the extension).** Pairing needs the approval in the app with a
   code the person compares; the end-to-end tests pair, refuse and revoke against a real daemon.
4. **A leaked token floods the daemon (daemon side).** The extension adds a limit for magnet links; the rest is the
   daemon's per-token limits, and a token is revoked in the app (tested end to end: the extension notices and says so).
5. **Cookies leak (mitigated).** A download's cookies are those of its own host and parent domains, never from a private
   window unless allowed, from the window's own store. The cookies of a site are sent to DLM only on a click, after a
   confirmation. The Files panel's checks carry cookies only to the page's own site (F1, F2).
6. **File names and URLs trick the person (mitigated).** Query strings never appear in a notification, text is escaped
   (no `innerHTML` anywhere), names lose misleading characters, and the daemon chooses the path.
7. **A remote server impersonates yours (as documented).** `http://` to another computer is warned about; there is no
   pinning in a browser.

The manifest has no `web_accessible_resources`, no `externally_connectable` and no custom content security policy; the
extension answers no message from another extension.
