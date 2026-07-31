# flai

A download manager that lives in a browser tab. Paste a magnet, pick a file, walk away — bytes
go straight to your disk in 8 MB slices, and it resumes from the exact byte after a server
restart, a spin-down, or a dropped connection.

The bytes come from [flai-api](https://github.com/jvoltci/flai-api), a bridge that holds 64 MB
of torrent pieces and forgets the rest. This side is the part that actually downloads.

**Chrome and Edge only**, deliberately — see below.

## Why the browser does the work

flai-api runs on a free tier with 512 MB of RAM, no disk, and a 15-minute sleep timer. Nothing
durable can live there. So the browser owns everything:

| State | Where |
|---|---|
| the magnet | IndexedDB |
| which bytes are done | IndexedDB |
| the file you're writing into | a `FileSystemFileHandle` in IndexedDB |
| your save folder | a `FileSystemDirectoryHandle` in IndexedDB |
| the token | `sessionStorage` |

The server can be restarted, redeployed or wiped mid-download and nothing is lost. When a slice
comes back `409 not_active`, the manager silently re-posts the magnet it already has and carries
on. A cold start is a pause in a progress bar, not an error.

## Two implementation details that matter

**The chunk loop has no timers.** Chrome clamps `setTimeout` in a hidden tab to once a minute
after five minutes. A loop scheduled on timers would crawl the moment you switch tabs — exactly
when a long download is running. So the loop is a chain of awaited fetches, which the throttler
does not touch. The only timer is the retry backoff, where waiting a minute is harmless.

**Bytes are piped, not buffered.** Each response body is written into a
`FileSystemWritableFileStream` as it arrives, so peak memory is a few hundred KB regardless of
file size, and there is no second copy in browser storage to hit a quota.

The cost of writing directly to your disk: a writable commits on `close()`, not on `write()`.
flai closes it on pause, on completion, and on `pagehide`. **A hard browser crash loses the
bytes written since the last commit** — resume then restarts from the file's real size on disk,
never from zero. Committing more often is not free: reopening with `keepExistingData` copies the
file so far, which for a 4 GB download would cost tens of GB of disk churn.

## Why Chrome/Edge only

`showDirectoryPicker()` and `showSaveFilePicker()` are Chrome/Edge only; Firefox and Safari ship
only OPFS, which would mean staging the whole file in browser storage and copying it out — 2×
the disk space and a quota ceiling well under 10 GB. Direct-to-disk was the deliberate choice.

## Playback

`streamable` on a file means "audio or video", not "your browser can play this". v3 handed
`.mkv` to a `<video>` element and showed an empty player. Now flai reads the first 256 KB,
identifies the container and codecs, and says so:

- **plays** — MP4/WebM with codecs Chrome decodes. Seeking works; the bridge serves 16 MB at a
  time, so a jump backwards past its window makes it restart the torrent — a stall, not a
  failure.
- **partial** — a container Chrome accepts holding something it does not decode, like DTS or
  AC-3. You get a warning instead of silence.
- **no** — Matroska, H.265, and friends. One button hands the stream to VLC, mpv or IINA as a
  two-line `.m3u`, and they play it fine over the same `Range`-capable URL.

No WASM remuxer. It would rescue exactly one case (H.264 in MKV) for a 2–3 MB payload, a worker
and a MediaSource pipeline, and still could not help H.265.

## Quick start

```bash
cp .env.example .env       # VITE_API_URL=http://localhost:5000 for a local bridge
npm install
npm run dev                # http://localhost:5173/flai/
```

```bash
npm run typecheck          # tsc --noEmit
npm run build              # typecheck, then dist/
npm run deploy             # publishes dist/ to gh-pages
```

`vite.config.ts` sets `base: '/flai/'` for `https://jvoltci.github.io/flai/`. Override with
`VITE_BASE=/` for a root-domain host.

## Config

| env | default | meaning |
|---|---|---|
| `VITE_API_URL` | `https://flai-api.onrender.com` | flai-api base URL |
| `VITE_BASE` | `/flai/` | Vite base path |

## Layout

```
src/
├── App.tsx                shell, tabs, health banner
├── api.ts                 session token, metadata, chunk fetch, SSE
├── download-manager.ts    the queue and the chunk loop        ← read this one
├── idb.ts                 IndexedDB: jobs + the folder handle
├── probe.ts               container/codec sniff → playability verdict
├── format.ts              bytes, speed, ETA
├── env.d.ts               the File System Access types TS 7 omits
├── styles.css             nilam import + flai's own layer
└── components/
    ├── Tabs.tsx           nilam's tablist contract, reimplemented in React
    ├── SignIn.tsx         one field, once per tab
    ├── Browse.tsx         magnet form + file table
    ├── Downloads.tsx      the queue, with progress and ETA
    ├── Player.tsx         video + verdict + external-player handoff
    └── Settings.tsx       save folder, session, and the limits written down
```

## Design system

Everything visual is [nilam](https://jvoltci.github.io/nilam/) 0.5 — one `@import`, no theme
runtime, no JS. Every colour on the page is a nilam token. The page is forced dark with
`<html class="dark">`.

v4 is a tablist over three panels rather than one long form, so the hero lost its card: a card
around the wordmark would have put a card inside a card on every panel, and nilam's `--rim` top
light makes two nested edges read as a dialog. The queue is a `<ul>` of cards rather than a
table, because a progress bar spanning a table row needs a `colspan` trick and the bar is the
primary information here, not the caption.

`Tabs.tsx` reimplements nilam's `tabs()` behaviour in React rather than importing it — that
module wires a tablist by mutating roles, ids and tabindex, which is the one thing not to do
inside React. The markup contract is unchanged, including `aria-selected` as the styling hook:
nilam drives the underline off it on purpose, so an inaccessible tablist visibly loses its
selected state instead of silently working.

Build output: **69 KB gzipped JS, 12.5 KB gzipped CSS**. The CSS is almost entirely nilam;
flai's own layer contains no colour literal. The project has exactly one, documented where it
sits: `<meta name="theme-color">` in `index.html`, which cannot take `var()`.

## Changed in v4

| | v3 | v4 |
|---|---|---|
| What it does | fetch a file list, stream one video | a real download queue with resume |
| Big downloads | one un-retried request; any blip restarted from zero | 8 MB slices, retried forever, resumed from the exact byte |
| Saving | a browser download link | direct to a folder you pick once |
| Progress | none | per-file bar, speed, ETA, peers over SSE |
| Password | typed on every fetch, sent in every body | once per tab, exchanged for a 12 h token |
| Playback | extension guess, empty player on MKV | codec probe, plain-English verdict, VLC handoff |
| Layout | one scrolling form | Downloads / Browse / Settings |
| react / vite / typescript | 18 / 5 / 5.6 | 19 / 8 / 7 |
