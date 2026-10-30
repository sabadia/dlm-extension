# Threat model (stub; completed by E7.5)

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
