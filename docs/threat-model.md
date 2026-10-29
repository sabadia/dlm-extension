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
