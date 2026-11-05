# Install guide

DLM for the browser needs the **DLM app** on the same computer (or a DLM server you reach by address and token). Install
the app first and open it once: [dlm-app releases](https://github.com/sabadia/dlm-app/releases/latest).

Download the files for your browser from the [latest release](https://github.com/sabadia/dlm-extension/releases/latest)
and check them against `SHA256SUMS` (`sha256sum -c SHA256SUMS`, or `shasum -a 256 -c SHA256SUMS` on macOS).

| Browser                             | File                                  | Section                                 |
| ----------------------------------- | ------------------------------------- | --------------------------------------- |
| Firefox                             | `dlm-extension-<version>-firefox.xpi` | [Firefox](#firefox)                     |
| Chrome, Edge, Brave, Opera, Vivaldi | `dlm-extension-<version>-chrome.zip`  | [Chromium](#chrome-edge-brave-chromium) |
| Safari (macOS 14 or later)          | `dlm-extension-<version>-safari.zip`  | [Safari](#safari-macos)                 |

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

## Safari (macOS)

Safari extensions live inside a small macOS app. The release has one (`dlm-extension-<version>-safari.zip`), built for
Apple silicon and Intel Macs, **signed ad hoc and not notarized**: Apple only allows that for developers, so Safari
runs it with a developer setting, and it has to be turned on again each time Safari restarts. If you have Xcode and an
Apple ID you can instead build it yourself from `dlm-extension-<version>-safari-xcode-project.zip` (open the project,
choose your team under Signing, run) and skip the unsigned-extension setting.

Safari has no downloads API, so the extension cannot take over downloads that start in the browser. What it does: the
**Send to DLM** menu on links, images, videos and pages, magnet and torrent links, and the **Files** list of the page
in the toolbar popup. More in [safari.md](safari.md).

1. Unzip `dlm-extension-<version>-safari.zip` and move **DLM Safari.app** to `/Applications`.
2. macOS marks downloaded apps as quarantined and will say it cannot be opened. Clear that once:
   `xattr -dr com.apple.quarantine "/Applications/DLM Safari.app"`. Then open the app once; it only shows a button that
   opens Safari's settings.
3. In Safari open **Settings, Advanced** and tick **Show features for web developers**. Then in the **Develop** menu
   choose **Allow Unsigned Extensions** (and enter your password). Repeat this after every Safari restart.
4. Open **Settings, Extensions**, tick **DLM** and allow it on **All Websites** (the extension needs to see the page to
   list its files).
5. Connect it to DLM. Safari cannot start the app's helper, so it does not pair automatically: it connects with an
   address and a token.
   - In the DLM app open **Manage, Access**, press **Add a token**, name it `Safari` and give it full access ("can
     change everything"). Copy the token (it is shown once) and note the address of the DLM server.
     **A token you paste is more powerful than the restricted token the other browsers get**: the restricted one is only
     issued by automatic pairing, which Safari cannot do yet, and a read-only token cannot send downloads. Use a token
     of its own so you can revoke it in **Manage, Access** whenever you like, and do not use this on a shared Mac user.
   - The address of the DLM app's own server changes each time it starts. To keep it, set a fixed address (for example
     `127.0.0.1:17171`) under **Manage, Daemon** and restart the daemon from there.
   - In Safari open the extension's options (the DLM button, then **Options**), find **DLM servers**, enter the address
     and token, press **Test**, then **Add server** and **Use this one**.
6. Press **Send a test download** in the options. The first time, DLM will most likely answer **"DLM refused requests
   from this browser's address"**: Chrome and Firefox reach DLM from an address it already knows, but Safari's is
   different on every Mac (it looks like `safari-web-extension://3F9A8B2C-…`), so you tell DLM to trust it once:
   - Copy the address from that message (it is also shown at the top of the **DLM servers** card).
   - In the DLM app open **Manage, Daemon**, add it as a line under **Allowed origins**, press **Save**, then
     **Restart now**. (It must be a full address; `*` is not accepted.)
   - Press **Send a test download** again: a task appears in the app.

To update, replace the app in `/Applications` with the new one and repeat steps 2 and 3.

## Pair with the app

This is for Chrome, Edge, Brave and Firefox (Safari connects with a token, above).

1. In the DLM app open **Manage, Access**, tick your browser under the browser helper and press **Install** (this lets
   the browser start the app's helper; it needs nothing from you again).
2. Open the extension's options (right-click the button, Options). **Get started** walks through the rest: it shows a
   six-digit code; check it matches the one in the app and press **Allow**.
3. Press **Send a test download**. A task appears in the app: you are set.

## Use it

- The toolbar button opens the **Files** side panel (a sidebar in Firefox, a popup in Safari): the files of the page you
  are on, with sizes.
- Downloads you start in the browser are taken over by DLM according to the rules in the options. Hold **Alt** while
  clicking to keep one in the browser. (Not in Safari.)
- Right-click a link, image, video or page for **Send to DLM**.

If something does not work, **Options, Advanced, Copy diagnostics** gives text for a bug report (it holds no token or
cookie). More: [privacy](privacy.md), [security](../SECURITY.md).
