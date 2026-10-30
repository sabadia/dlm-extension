# Browser differences

Chrome (and the Chromium browsers that use its build) and Firefox share one hand-off. What differs is isolated in
`attachIntercept` (`src/background/register.ts`) and in the Firefox branch of `InterceptService.onHeadersReceived`.

|                           | Chrome, Edge, Brave, Opera, Vivaldi                                                                                                                                               | Firefox                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Taking a download         | `downloads.onCreated`, then `cancel`, then `erase`                                                                                                                                | The same path                                                                                                                                                                                                                                                      |
| Download item             | `finalUrl` and `referrer` are set                                                                                                                                                 | Neither is set. The address before redirects, the page and the referrer come from `webRequest` (`documentUrl`, the `Referer` header). `filename` is a full path; the directory is dropped                                                                          |
| Avoiding a download entry | Not possible. `webRequest` is observe-only                                                                                                                                        | Optional. An attachment (`Content-Disposition: attachment`) that the rules take is captured in `onHeadersReceived` and the request is cancelled, so `onCreated` does not fire. The manifest permission is `webRequestBlocking`, declared only on the Firefox build |
| Own fallback              | `byExtensionId`, the extension origin on the request, and the set of addresses we restarted                                                                                       | The same. A blocking listener must not cancel those                                                                                                                                                                                                                |
| Cookies                   | `cookies.getAll` for the download's address, then again with `partitionKey.topLevelSite` set to the page origin (CHIPS). A browser without partition keys ignores the second call | The same call, plus `storeId` from the request (containers and private windows)                                                                                                                                                                                    |
| Private windows           | Off unless the setting allows them. No cookies are read when it is off                                                                                                            | The same                                                                                                                                                                                                                                                           |

Both browsers leave `blob:` and `data:` addresses, and anything that is not GET, in the browser. Holding Alt (or the key
chosen in the settings) is seen by the content script and keeps that download in the browser.

## What the hand-off watches, and what it keeps

- `webRequest` listeners cover navigations and `other` requests only (`main_frame`, `sub_frame`, `other`), never images,
  scripts or XHR. Chrome also asks for `extraHeaders`, without which it hides `Referer`; Firefox has no such option.
- Headers and POST bodies of requests in flight are kept **in memory** for a few seconds (at most 300 requests, eight
  bodies), not in storage: they exist until the response says whether the request is a download. The response of a
  download candidate is written to `storage.session`, and `onCreated` waits for those writes. A worker that stops in
  that window loses only metadata; the download is still handed over from its item.
- Chrome's `webRequest` has no cookie store: private windows are found through `cookies.getAllCookieStores()` (the store
  that lists the tab). Firefox gives the store on the request (`cookieStoreId`) and keeps a restarted download in it.
- A browser reports a download size of `0` or `-1` when it does not know it; that is "unknown" to the rules.
- Alt or Shift held while the click that started a download is seen by a content script in every frame, from real input
  only. A download that opens in a new tab (`target=_blank`) has another tab id than the click, so the key is not seen
  there; this is a known limit.
- A POST is handed over only when its body is small, text, and url-encoded or raw (not multipart), and the response looks
  like a download. The browser fallback restarts it as a POST (`downloads.download` with `method`, `body`, `headers`).

## The Files panel

| Topic         | Chrome                                                                                       | Firefox                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Surface       | `side_panel` with the `sidePanel` permission; `setPanelBehavior` opens it on a toolbar click | `sidebar_action`; the toolbar click runs `action.onClicked`, which opens the sidebar |
| Popup instead | The setting clears the panel behaviour and sets the popup                                    | The setting sets the popup, and `action.onClicked` stops opening the sidebar         |
| Shortcut      | `Alt+Shift+D` opens the panel                                                                | The same, opens the sidebar                                                          |
| Following tab | One panel for the window, following the active tab                                           | The same                                                                             |
