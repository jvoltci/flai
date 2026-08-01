/* flai — the downloader.
 *
 * This file is the whole download engine. The page just hands it a job and gets out of the
 * way.
 *
 * ── why a service worker ───────────────────────────────────────────────────────
 *
 * flai-api never serves a whole file: every response is clamped to 16 MB, so a download is a
 * few hundred separate Range requests that have to be stitched back together. The obvious
 * ways to do that in a page are both bad — buffering into a Blob needs the whole file in RAM,
 * and the File System Access API means a folder picker and a permission prompt.
 *
 * A service worker can answer a request with a ReadableStream. So it invents one URL, replies
 * with the right Content-Length and Content-Disposition, and feeds it slice by slice. Chrome
 * sees a single ordinary download: it lands in your Downloads folder with no prompt, and
 * Chrome's own download bar is the progress UI.
 *
 * The retry loop lives on this side of that stream, which is the point. A server restart, a
 * cold start after the free tier spins down, a dropped connection — all of it is handled
 * without the stream ever noticing. Chrome sees one uninterrupted download.
 *
 * ── the one thing this cannot do ───────────────────────────────────────────────
 *
 * Resume after the tab closes. A native download cannot be restarted at an offset, so if the
 * stream dies for good, the download dies with it. That is the trade for having no prompts:
 * everything that actually goes wrong in practice is invisible, and the one thing that is not
 * recoverable is the one you control.
 */

const CHUNK = 8 * 1024 * 1024;
const MAX_BACKOFF_MS = 30_000;
const BUSY_WAIT_MS = 2000;

/** id -> job, handed over by the page just before it triggers the download. */
const JOBS = new Map();

// Take over immediately. Without these a new worker sits in "waiting" behind the old one and
// the first download after a deploy is served by stale code.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type !== 'flai-download') return;
  JOBS.set(message.job.id, message.job);
  event.source?.postMessage({ type: 'flai-accepted', id: message.job.id });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/__flai-dl')) return;
  const job = JOBS.get(url.searchParams.get('id'));
  if (!job) return; // a reload of a finished download URL — let it 404 rather than restart
  JOBS.delete(job.id);
  event.respondWith(respond(job));
});

/** Fatal means stop; anything else is retried forever. */
class Fatal extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Throttled, and that is not a nicety. reader.read() hands back whatever the network gave —
 * often 16 to 64 KB — so an unthrottled report would call clients.matchAll() and postMessage
 * a few hundred times per 8 MB slice, on the same task queue that is feeding the download. */
const REPORT_EVERY_BYTES = 1024 * 1024;

async function report(id, patch) {
  for (const client of await self.clients.matchAll()) {
    client.postMessage({ type: 'flai-progress', id, ...patch });
  }
}

function respond(job) {
  let pos = 0;
  let reader = null;
  let backoff = 500;
  let reported = 0;
  let lastSliceStart = -1;

  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (pos >= job.size) {
          controller.close();
          await report(job.id, { state: 'done', bytes: pos });
          return;
        }

        if (!reader) {
          /* If pos has not moved since the last slice, that slice yielded nothing. Without a
           * guard this spins: fetch, read done immediately, fetch again, as fast as the
           * network allows. It takes the bridge answering 206 with an empty body, but a tight
           * infinite loop inside a service worker is not a failure mode worth leaving open. */
          if (pos === lastSliceStart) {
            await sleep(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          }
          lastSliceStart = pos;
          try {
            reader = (await slice(job, pos)).body.getReader();
          } catch (err) {
            if (err instanceof Fatal) {
              controller.error(err);
              await report(job.id, { state: 'error', bytes: pos, error: err.message });
              return;
            }
            await sleep(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            continue;
          }
        }

        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          /* A drop mid-slice keeps everything already enqueued. The next pass asks for the
           * rest of the file starting at pos, so nothing is re-sent and nothing is lost. */
          reader = null;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }

        if (chunk.done) {
          reader = null;
          continue;
        }

        pos += chunk.value.byteLength;
        // Reset only once bytes actually arrive, so a run of empty slices keeps backing off.
        backoff = 500;
        controller.enqueue(chunk.value);
        if (pos - reported >= REPORT_EVERY_BYTES) {
          reported = pos;
          // Not awaited: the page's status line must never pace the download.
          void report(job.id, { state: 'running', bytes: pos });
        }
        return;
      }
    },
    cancel() {
      // Chrome cancelled the download, or the tab went away.
      reader?.cancel().catch(() => {});
      void report(job.id, { state: 'cancelled', bytes: pos });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': job.contentType || 'application/octet-stream',
      'Content-Length': String(job.size),
      // filename* rather than filename: torrent names are routinely non-ASCII.
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.name)}`,
      'Cache-Control': 'no-store',
    },
  });
}

/** One 8 MB slice, retried until it works or a Fatal says otherwise. */
async function slice(job, pos) {
  const end = Math.min(job.size - 1, pos + CHUNK - 1);
  let backoff = 500;

  for (;;) {
    let res;
    try {
      res = await fetch(`${job.baseUrl}/torrent/${job.infoHash}/${job.fileIndex}`, {
        headers: { Range: `bytes=${pos}-${end}`, Authorization: `Bearer ${job.token}` },
      });
    } catch {
      // Offline, DNS, or the box is cold-starting. Always worth another go.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }

    if (res.status === 206 || res.status === 200) return res;

    const body = await res.json().catch(() => null);
    const code = body?.error?.code;
    const message = body?.error?.message ?? `request failed (${res.status})`;

    /* The stateless contract. flai-api keeps no magnets, so when it drops a torrent — spun
     * down, restarted, or evicted for capacity — it cannot get it back on its own. We still
     * have the magnet, so we hand it back and carry on. This is the single line that turns a
     * free-tier restart from a failed download into a pause nobody notices. */
    if (code === 'not_active') {
      await report(job.id, { state: 'waking' });
      await readd(job);
      continue;
    }
    // Another reader holds this torrent's single sliding window.
    if (code === 'busy') {
      await sleep(BUSY_WAIT_MS);
      continue;
    }
    if (res.status === 401) throw new Fatal('session expired — sign in again');
    if (res.status === 404 || res.status === 400 || res.status === 416) throw new Fatal(message);

    // 429 and 5xx are transient by definition.
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

async function readd(job) {
  try {
    const res = await fetch(`${job.baseUrl}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.token}` },
      body: JSON.stringify({ url: job.magnet }),
    });
    if (res.status === 401) throw new Fatal('session expired — sign in again');
  } catch (err) {
    if (err instanceof Fatal) throw err;
    // Metadata can take a while on a cold box; the caller retries the slice regardless.
    await sleep(2000);
  }
}
