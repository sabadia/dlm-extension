# Safari

Safari runs the same code as the other browsers (`pnpm build:safari`, output `.output/safari-mv3`). A Safari web
extension can only ship inside a macOS app, so the build is converted and embedded (below). What Safari cannot do is
left out by the build and by the background script instead of failing.

## Download

The release has two Safari files, built by the macOS job of the release workflow (`tools/safari-package.sh`):

- `dlm-extension-<version>-safari.zip`: `DLM Safari.app` with the extension inside, universal (Apple silicon and
  Intel), ad-hoc signed, not notarized. Install steps are in the [install guide](install.md#safari-macos).
- `dlm-extension-<version>-safari-xcode-project.zip`: the Xcode project, to build and sign with your own Apple ID.

They are not signed with a paid Apple Developer ID, which is the only way to run without "Allow Unsigned Extensions".
A notarized build inside the DLM app is the plan.

## What works, what does not

| Feature                                 | Safari                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Context menu "send to DLM", links page  | Yes                                                                                                                |
| Magnet, eD2K and `.torrent` links       | Yes                                                                                                                |
| Media on the page (content script)      | Yes. Media seen only in network headers needs `webRequest`, which Safari offers to an event page when it allows it |
| The Files panel                         | As the toolbar popup. There is no side panel or sidebar                                                            |
| Taking over the browser's own downloads | **No.** Safari has no `downloads` API, so a download cannot be cancelled and handed to DLM                         |
| Notifications of failed captures        | No `notifications` API; the popup shows the state                                                                  |
| Cookies for a sent link                 | `cookies.getAll` for the address; no CHIPS `partitionKey`                                                          |

The build drops what Safari lacks: no `downloads`, `notifications` or `sidePanel` permission, no `key` or
`minimum_chrome_version`, and the background is a script page (`background.scripts`) instead of a service worker. The
background checks for each API before it registers a listener (`entrypoints/background.ts`), so a missing one skips the
feature.

## Try it locally

```sh
tools/safari-convert.sh        # builds, converts with Apple's converter, prints the next steps
```

Run the generated app from Xcode, turn on Safari > Develop > Allow Unsigned Extensions, and enable DLM in Safari >
Settings > Extensions. Then go through the Safari section of `docs/manual-tests.md`.

## Reaching the daemon

Safari has no native-messaging host manifests: `runtime.sendNativeMessage` goes only to the app that carries the
extension, whatever host name is given. So discovery and pairing (`connect`, `pair`, `pair.status`) must go through the
carrying app, and the REST calls can go straight to `http://127.0.0.1:<port>` once the extension has a token.

The extension already treats a missing native host as "ask for a token" (`src/lib/connection/resolve.ts`), so the first
step works today with a pasted token. What is left, and needs the Apple tooling and an Xcode project that dlm-app owns:

1. Embed the extension in `DLM.app` (`Contents/PlugIns/DLM Safari.appex`), sign it with its own entitlements before the
   app (`tools/package_macos.sh` in dlm-app), notarize.
2. A handler in the appex that answers `connect`/`pair`/`pair.status` for the extension (daemon address from an App
   Group container that DLM.app writes), and a daemon pairing start that does not need the admin token.
3. Spike (`docs/spikes/safari.md` once run): which `Sec-Fetch-Site` Safari sends from an extension to the loopback
   daemon. The daemon refuses cross-site POSTs (`internal/api/middleware.go`); if Safari sends `cross-site`, the daemon
   must accept an extension-scope Bearer token whatever the origin.

The spike's first answer is in: Safari sends its requests as `Sec-Fetch-Site: cross-site` from
`safari-web-extension://<uuid>`, and the daemon refuses any state-changing request from an origin that is not in
`server.allowed_origins` ("cross-origin request rejected"), token or not. The extension now says so, with its own
address, and the install guide has the person add it once. This is deliberate: the guard keeps web pages and other
extensions from using a token. An automatic way (the app adding the origin when it approves the extension) comes with
the pairing handler below.

Until that handler exists, a Safari user connects with a pasted token (install guide). Named tokens are full-access or
read-only; the restricted `extension` token that the other browsers get is issued only by pairing. So **Safari holds a
full-access token** for now, which is why the guide says to give it a token of its own. Closing that gap (the handler
above, or letting the daemon issue the extension token to a paired app on request) is the first thing to do after the
spike.

The browser name sent to the daemon is `other` until the daemon knows `safari` (`daemonBrowserName`).
