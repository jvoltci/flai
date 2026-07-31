# flai

A small browser frontend for [flai-api](../flai-api). Paste a magnet, list files, stream video with seeking, or download.

## Quick start

```bash
cp .env.example .env       # set VITE_API_URL=http://localhost:5050 if running the API locally
npm install
npm run dev                # http://localhost:5173/flai/
```

## Production build

```bash
npm run build              # → dist/
npm run preview            # serve dist/ locally
```

### Deploy to GitHub Pages

```bash
npm run deploy             # publishes dist/ to gh-pages branch
```

`vite.config.ts` sets `base: '/flai/'` to match `https://jvoltci.github.io/flai/`. Override with `VITE_BASE=/` for root-domain hosts (Cloudflare Pages, Netlify, Vercel).

## Config

| env | default | meaning |
|---|---|---|
| `VITE_API_URL` | `https://flai-api.onrender.com` | flai-api base URL |
| `VITE_BASE`    | `/flai/` | Vite/router base path |

## Stack

- Vite 5 + React 18 + TypeScript (strict)
- [nilam](https://jvoltci.github.io/nilam/) for colour and components — one `@import`, no theme
  runtime and no JS. Every colour on the page is a nilam token; the page is forced dark with
  `<html class="dark">`, so step 9 is the L 0.66 glow and `--brand-ink` follows it.
- Range-aware `<video>` for seeking while the swarm is still pulling chunks

Bundle size, from `npm run build`: **48.3 KB gzipped JS, 8.7 KB gzipped CSS**
(149.8 KB / 38.6 KB raw). The CSS is almost entirely nilam — tokens, scale, base and the whole
`.n-*` component layer, plus the second P3 palette behind `@media (color-gamut: p3)`. flai's own
stylesheet is 88 lines of rules and contains no colour literal at all; the only one in the
project is `<meta name="theme-color">`, which cannot take `var()`.

## What got modernized (v3.0)

The previous build was Create React App 2.1.8 + React 16 + react-router-dom 4 — all 5+ years old, with security vulnerabilities and incompatibility with modern OPFS / WebCodecs APIs. Replaced wholesale with Vite + React 18.

Other fixes:
- Form no longer POST'd a plaintext password to `/download` as the browser-fallback (URL leak).
- `<List>` no longer hardcoded the production API URL — uses the configured `VITE_API_URL`.
- New video player uses Range-aware streaming so users can scrub the timeline before download completes.
- All buttons/inputs accessible (labels, aria-roles).
