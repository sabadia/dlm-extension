# Install guide

DLM for the browser needs the **DLM app** on the same computer (or a DLM server you reach by address and token). Install
the app first and open it once: [dlm-app releases](https://github.com/sabadia/dlm-app/releases/latest).

Download the files for your browser from the [latest release](https://github.com/sabadia/dlm-extension/releases/latest)
and check them against `SHA256SUMS` (`sha256sum -c SHA256SUMS`, or `shasum -a 256 -c SHA256SUMS` on macOS).

## Firefox

1. Download `dlm-extension-<version>-firefox.xpi` and open it in Firefox (drag it onto a window, or File, Open File).
   It is signed by Mozilla as an unlisted add-on, so Firefox installs it without developer settings.
2. Allow it when Firefox asks, and grant access to all sites (the extension needs it to see downloads, headers and cookies).
3. Continue with [Pair with the app](#pair-with-the-app).

## Chrome, Edge, Brave (Chromium)

The extension is not in a store yet, so Chromium browsers load it as an unpacked extension. This needs **developer mode**,
and Chrome will show a notice about developer-mode extensions each time it starts; that is expected for a build that does
not come from the Chrome Web Store.

1. Download `dlm-extension-<version>-chrome.zip` and unzip it into a folder you will keep (the browser reads the
   extension from there; if you delete the folder the extension stops working).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. The extension has a fixed id, `gfjgahdobbldpjiijaakihgmmjemdalg`, the same on every Chromium browser; the DLM app uses it
   to allow the browser to talk to the extension.
5. Pin the DLM button to the toolbar (the puzzle-piece menu), then continue below.

To update, download the new zip, replace the folder's contents and press the reload button on the extension's card.

## Pair with the app

1. In the DLM app open **Manage, Access** and choose **Install for this browser** (this lets the browser start the app's
   helper; it needs nothing from you again).
2. Open the extension's options (right-click the button, Options). **Get started** walks through the rest: it shows a
   six-digit code; check it matches the one in the app and press **Allow**.
3. Press **Send a test download**. A task appears in the app: you are set.

## Use it

- The toolbar button opens the **Files** side panel (a sidebar in Firefox): the files of the page you are on, with sizes.
- Downloads you start in the browser are taken over by DLM according to the rules in the options. Hold **Alt** while
  clicking to keep one in the browser.
- Right-click a link, image, video or page for **Send to DLM**.

If something does not work, **Options, Advanced, Copy diagnostics** gives text for a bug report (it holds no token or
cookie). More: [privacy](privacy.md), [security](../SECURITY.md).
