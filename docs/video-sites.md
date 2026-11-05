# Video sites (YouTube)

A video site's player does not fetch one file. YouTube's fetches signed, short-lived pieces from `googlevideo.com`
(`/videoplayback`, audio and video apart, in byte ranges), so those requests are not downloads: sent to DLM they
expire, throttle or give half a video. The extension therefore does two things.

- **It does not list those requests.** `isPlayerStream` in `src/lib/media/sites.ts` leaves them out of every tab's list.
- **It lists the page.** A page that is one video becomes one row in the Files panel (badge "YouTube", named after the
  video). Recognised: `youtube.com/watch?v=`, `/shorts/`, `/live/`, `/embed/`, `m.` and `music.youtube.com`, and
  `youtu.be/`. A playlist, a channel or the home page is not a video and gets no row. The address sent is the video
  alone (`https://www.youtube.com/watch?v=ID`): a `list=`, a time or a tracking parameter is dropped.

YouTube moves from video to video without loading a page. The content script scans again on YouTube's own
`yt-navigate-finish` event and on `popstate`, so the row follows the video that is playing.

## Downloading

The row's download button sends a capture with `resolverKind: ytdlp`: the daemon's yt-dlp reads the page and downloads
the video, naming the file after it. The row's menu has **Quality**: the extension asks the daemon to resolve the page
(`POST /v1/resolve` with `source.resolverKind = ytdlp`), which lists what the video is offered in (one entry per
height, and the best audio only). The chip you press is sent as `mediaCandidates[0].variant`, which the daemon uses as
the yt-dlp format selector.

The cookies of `youtube.com` go with the capture for that task only, as for every download, so a video that needs a
signed-in session (age, membership) works when you are signed in in that browser. Private windows follow the usual
rule: no cookies unless allowed.

## Needs

yt-dlp on the DLM computer (the app and `dlm` find or fetch it) and a daemon from v0.7 (formats in `resolve`).
Without them the row is still listed and the download fails with the daemon's reason.

## Adding another site

Add its address forms to `videoPageOf` and its player requests to `isPlayerStream`, extend `VideoSite`, and add the
site name to the `files.site.*` messages. Everything else (the row, the quality chips, the download) is by `site`.
