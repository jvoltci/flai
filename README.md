# flai

Paste a magnet, click Save, and the file lands in your Downloads folder. No picker, no
permission prompt, no queue to manage — and it keeps going through server restarts, cold
starts and dropped connections without telling you about it.

One page. The bytes come from [flai-api](https://github.com/jvoltci/flai-api), a bridge that
holds 64 MB of torrent pieces and forgets the rest.

**Chrome or Edge**, because the download runs through a service worker.

## How the download works

flai-api never serves a whole file — every response is clamped to 16 MB — so a download is a
few hundred separate `Range` requests that have to be stitched back together. The obvious ways
to do that in a page are both bad: buffering into a Blob needs the whole file in RAM, and the
File System Access API means a folder picker and a permission prompt on every resume.

So [`public/sw.js`](public/sw.js) does it instead. A service worker can answer a request with a
`ReadableStream`, so it invents one URL, replies with the right `Content-Length` and
`Content-Disposition`, and feeds it slice by slice:

```
page                     service worker                    flai-api
 │  postMessage(job) ──────►│
 │  <a href="__flai-dl">    │
 │  click ─────────────────►│  Range: bytes=0-8388607  ──────►│
 │                          │◄────────────────────────────────│
 │◄── one native download ──│  Range: bytes=8388608-…  ──────►│
 │    (Chrome's own bar)    │◄──── 409 not_active ────────────│
 │                          │  POST /metadata (the magnet) ──►│
 │◄── still one download ───│  Range: bytes=8388608-…  ──────►│
```

The retry loop is on the worker's side of that stream, which is the whole point. Chrome sees a
single uninterrupted download; the free tier spinning down mid-transfer is invisible.

**The one thing this cannot do is resume after the tab closes.** A native download cannot be
restarted at an offset, so if the stream dies for good, it dies. That is the trade for having
no prompts: everything that actually goes wrong is handled silently, and the one unrecoverable
case is the one you control.

## Tests

`public/sw.js` lives outside the bundle, so TypeScript never sees it and a typo there is a
broken download. `npm test` runs it in Node against a fake bridge that lies, stalls and drops
connections, and asserts the bytes that come out are byte-for-byte the file that went in:

| | |
|---|---|
| clean 20 MB run | byte-for-byte, correct headers |
| bridge forgets the torrent (`409`) | file intact, magnet re-posted exactly once |
| connection drops mid-slice | nothing lost, nothing duplicated |
| network gone entirely | recovers |
| 500s and a busy window | recovers |
| expired token | fails cleanly instead of looping forever |
| progress messages | throttled to ~1/MB, not ~305 |

## Playback

`streamable` means "audio or video", not "your browser can play this". v3 handed `.mkv` to a
`<video>` and showed an empty player. Now flai reads the first 256 KB, identifies the container
and codecs, and says which:

- **plays** — MP4/WebM with codecs Chrome decodes. Seeking works; the bridge serves 16 MB at a
  time, so a jump backwards past its window makes it restart the torrent — a stall, not a
  failure.
- **partial** — a container Chrome accepts holding something it does not decode, like DTS or
  AC-3. A warning instead of silence.
- **no** — Matroska, H.265 and friends. One button hands the stream to VLC, mpv or IINA as a
  two-line `.m3u`; they play it fine over the same URL.

No WASM remuxer. It would rescue only H.264-in-MKV for a 2–3 MB payload and still not help
H.265.

## Quick start

```bash
cp .env.example .env       # VITE_API_URL=http://localhost:5000 for a local bridge
npm install
npm run dev                # http://localhost:5173/flai/
npm test                   # the download engine, no network
npm run build              # typecheck, then dist/
npm run deploy             # publishes dist/ to gh-pages
```

**`npm run deploy` does not build.** It is `gh-pages -d dist`, so it publishes whatever is
already in `dist/`. Always `npm run build && npm run deploy`.

Service workers need HTTPS or localhost, so downloads work on `localhost` and on GitHub Pages,
but not over a plain-HTTP LAN address.

## Config

| env | default | meaning |
|---|---|---|
| `VITE_API_URL` | `https://flai-api.onrender.com` | flai-api base URL |
| `VITE_BASE` | `/flai/` | Vite base path; also the service worker's scope |

## Layout

```
public/sw.js        the download engine — retries, re-adds, streams   ← read this one
src/
├── App.tsx         the whole page: sign in, magnet, file list, activity
├── Player.tsx      video + codec verdict + external-player handoff
├── downloader.ts   registers the worker, hands it a job, clicks a link
├── api.ts          session token, metadata, stream URL, SSE stats
├── probe.ts        container/codec sniff → playability verdict
├── format.ts       bytes and percentages
└── styles.css      nilam import + flai's own layer
test/sw.test.js     the download engine against a bridge that misbehaves
```

## Design system

Everything visual is [nilam](https://jvoltci.github.io/nilam/) 0.6 — one `@import`, no theme
runtime, no JS. Every colour is a nilam token; the page is forced dark with
`<html class="dark">`.

The activity line under the form is deliberately **not** a progress bar. Chrome's download bar
already draws one, and a second bar beside it was most of what made the earlier three-tab
version feel heavy. What that line is for is the state Chrome cannot know: *waking the bridge*
— the free tier cold-starting mid-download while the worker retries. To Chrome that is just a
stream that has gone quiet for a minute.

Build output: **~66 KB gzipped JS, ~12.6 KB gzipped CSS**. flai's own CSS layer contains no
colour literal. The project has exactly one, documented where it sits: `<meta
name="theme-color">` in `index.html`, which cannot take `var()`.

## Changed in v4

| | v3 | v4 |
|---|---|---|
| Big downloads | one un-retried request; any blip restarted from zero | 8 MB slices stitched into one native download, retried forever |
| Saving | browser download link | straight to Downloads, no prompt |
| Password | typed on every fetch, sent in every body | once, exchanged for a 12 h token |
| Playback | extension guess, empty player on MKV | codec probe, plain verdict, VLC handoff |
| Stream URLs | unauthenticated | token-bearing, expiring |
| Tests | none | 7, covering the download engine's failure modes |
| react / vite / typescript | 18 / 5 / 5.6 | 19 / 8 / 7 |
