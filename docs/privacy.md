# Privacy statement

**DLM for the browser collects nothing.** It has no analytics, no telemetry, no advertising, no account and no server of
ours. Nothing it knows leaves your computer except to the DLM server you chose.

## What it handles

- **Downloads and links you hand to DLM.** The address, the page it came from, the file name and size, and, so that a
  sign-in is not lost, the cookies of the download's own site (never from a private window, unless you allowed it). They go
  to the DLM server you use: the DLM app on this computer, or a server you added yourself.
- **The cookies of a site, when you ask.** "Send this site's cookies to DLM" sends the cookies of the site in front of you,
  after a confirmation that names the site and how many. DLM keeps them until you remove them in the app.
- **The files of the page you are on.** The Files panel looks at the links and media of the open page, and asks the file's
  own server for its size (a request for the headers, or for one byte). It does this on your computer; the answers are not
  sent anywhere unless you press Download.
- **A token for your DLM server.** Kept in the extension's own storage, never shown again, never put in a log, a
  notification or a bug report. It is revoked in the DLM app.
- **Settings.** Your rules and choices, in the extension's storage. They are exported only when you export them, and the
  file holds no token.

## What it does not do

- It does not send your browsing history, the pages you visit or the downloads you make anywhere but to your own DLM.
- It does not read pages for any other purpose, and it does not load code from the internet.
- It does not share anything with the makers of the extension or anyone else.

## Why the permissions

| Permission                           | Why                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `downloads`                          | See a download the browser starts, cancel it and hand it to DLM (or let it continue in the browser)                |
| `webRequest` (Firefox also blocking) | See the headers of a download (name, size, type) before it starts; Firefox cancels an attachment before it appears |
| `cookies`                            | Give DLM the sign-in of the download's own site; send a site's cookies when you ask                                |
| `storage`                            | Your settings and the token                                                                                        |
| `nativeMessaging`                    | Find and pair with the DLM app on this computer                                                                    |
| `alarms`                             | Check the connection once a minute and look for expired links                                                      |
| `notifications`                      | Tell you a download was sent, failed, or needs a fresh link                                                        |
| `contextMenus`                       | The right-click menus                                                                                              |
| `sidePanel` (Chrome)                 | The Files side panel                                                                                               |
| Access to all sites                  | See downloads, headers and cookies on any site, and check the files of any page you open the panel on              |

Questions or a concern: see [SECURITY.md](../SECURITY.md).
