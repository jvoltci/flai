# flai

Paste a magnet, click Save, and your browser downloads the file. That's it.

One page, no queue to manage, no prompts. The bytes come from
[flai-api](https://github.com/jvoltci/flai-api), a bridge that holds 64 MB of torrent pieces and
forgets the rest.

## How the download works

It's a link.

```html
<a href="…/torrent/<hash>/5?dl=1&t=<token>&m=<magnet>" download>Save</a>
```

Your browser's own download manager takes it from there — progress, pause, resume, the lot.
flai contributes no JavaScript to the transfer at all.

That is the second attempt. The first shipped a service worker that stitched 16 MB slices into
a stream, because the bridge used to clamp every response to 16 MB and refuse un-ranged
requests. It was clever, it tested green, and it did not work in the browser. The memory bound
belonged inside the bridge's route, not in the protocol — so it moved there, and this side went
back to a link.

**Two things make the plain link robust:**

- The URL carries its own **magnet** (`&m=`). The bridge stores nothing, so after a spin-down
  or a redeploy it has no idea what this torrent is — but the link does, and the route re-adds
  it. 
- The bridge sets `Accept-Ranges` and a stable `ETag`, so when Chrome retries an interrupted
  download with `Range: bytes=N-`, it resumes instead of starting over.

Together those mean **a download survives a server restart with no client-side code**.

The honest limit: if you cancel it in Chrome, it's cancelled. There is no queue here to resume
it from.

## The page

One card of controls, one table. What is worth knowing about it:

- **Pasting a magnet loads it.** The whole interaction is "paste a magnet", so the click
  afterwards was the only friction left in the happy path. The paste handler takes the pasted
  string directly rather than reading state, because `setUrl` has not landed yet on that tick.
- **Save acknowledges itself.** An `<a download>` gives the page no signal at all and Chrome's
  download bar is often collapsed, so clicking Save used to look like nothing happening. The
  button turns into a green "✓ Started" for eight seconds.
- **One file at a time is stated, not discovered.** The bridge keeps a single sliding window
  per torrent, so a second file started now is refused. Left unsaid, that arrives as a
  mysteriously failed download in Chrome.
- **A filter appears above eight files.** Below that it is noise; above it, a 300-file torrent
  is a wall.
- **The lede disappears once a torrent is open.** It explains the app to someone who has not
  used it; after that it is explaining what they are already doing.
- The right field is focused on load, and Escape closes the player.

## Playback

`streamable` means "audio or video", not "your browser can play this". v3 handed `.mkv` to a
`<video>` and showed an empty player. Now flai reads the first 256 KB, identifies the container
and codecs, and says which:

- **plays** — MP4/WebM with codecs Chrome decodes. Seeking works.
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
npm run build              # typecheck, then dist/
npm run deploy             # publishes dist/ to gh-pages
```

**`npm run deploy` does not build.** It is `gh-pages -d dist`, so it publishes whatever is
already sitting in `dist/`. Always `npm run build && npm run deploy` — publishing a stale
`dist` once cost an afternoon of "why can't I see my changes".

## Config

| env | default | meaning |
|---|---|---|
| `VITE_API_URL` | `https://flai-api.onrender.com` | flai-api base URL |
| `VITE_BASE` | `/flai/` | Vite base path |

## Layout

```
src/
├── App.tsx       the whole page: sign in, magnet, file list
├── Player.tsx    video + codec verdict + external-player handoff
├── api.ts        session token, metadata, stream and download URLs, SSE stats
├── probe.ts      container/codec sniff → playability verdict
├── format.ts     bytes
├── main.tsx      mount, and unregister the v4.0 service worker
└── styles.css    nilam import + flai's own layer
```

`main.tsx` unregisters any service worker it finds. Deploying a build without one does **not**
remove a worker a browser already installed — it keeps controlling the page and intercepting
requests. It has to be told.

## Design system

Everything visual is [nilam](https://jvoltci.github.io/nilam/) 0.6 — one `@import`, no theme
runtime, no JS. Every colour is a nilam token; the page is forced dark with
`<html class="dark">`.

There is no progress bar in the page, on purpose. Chrome's download bar already has one, and
the version that drew its own alongside it is the version that got deleted.

Build output: **~65 KB gzipped JS, ~12.6 KB gzipped CSS**. flai's own CSS layer contains no
colour literal. The project has exactly one, documented where it sits: `<meta
name="theme-color">` in `index.html`, which cannot take `var()`.

## Changed in v4

| | v3 | v4 |
|---|---|---|
| Big downloads | died partway; no resume | self-healing URL + Chrome's own resume |
| Password | typed on every fetch, sent in every body | once, exchanged for a 12 h token |
| Stream URLs | unauthenticated | token-bearing, expiring |
| Playback | extension guess, empty player on MKV | codec probe, plain verdict, VLC handoff |
| react / vite / typescript | 18 / 5 / 5.6 | 19 / 8 / 7 |
