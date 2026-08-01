import test from 'node:test';
import assert from 'node:assert/strict';

/* public/sw.js is the whole download engine and it runs somewhere a debugger is awkward and a
 * unit test is impossible — inside a service worker, feeding a native browser download. So it
 * is exercised here instead: real ReadableStream, real Response, a fake bridge that lies,
 * stalls and drops connections, and one assertion that matters — the bytes that come out are
 * byte-for-byte the file that went in.
 *
 * Node has ReadableStream, Response and fetch as globals, so the only shims needed are the
 * service worker's own: self, clients, skipWaiting. */

// Must span several 8 MB slices, otherwise a fault injected into the second request is never
// reached and the test passes without testing anything. Not a multiple, so the short final
// slice is covered too.
const SIZE = 20_000_003;
const FILE = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) FILE[i] = i % 251; // prime stride, so any offset slip shows up

const handlers = new Map();
const posted = [];

globalThis.self = {
  addEventListener: (type, fn) => handlers.set(type, fn),
  skipWaiting: () => {},
  clients: {
    claim: async () => {},
    matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
  },
};

await import('../public/sw.js');

/** A bridge that behaves like flai-api, plus whatever failures a test asks for. */
function makeBridge({ failures = [] } = {}) {
  let call = 0;
  const state = { active: false, calls: 0, metadataCalls: 0 };

  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/metadata')) {
      state.metadataCalls++;
      state.active = true;
      return new Response(JSON.stringify({ infoHash: 'x' }), { status: 200 });
    }

    state.calls++;
    const fault = failures[call++];

    if (fault === 'network') throw new TypeError('Failed to fetch');
    if (fault === 'not_active') {
      state.active = false;
      return new Response(JSON.stringify({ error: { code: 'not_active', message: 'gone' } }), {
        status: 409,
      });
    }
    if (fault === 'busy') {
      return new Response(JSON.stringify({ error: { code: 'busy', message: 'busy' } }), {
        status: 409,
      });
    }
    if (fault === 'server') {
      return new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), {
        status: 500,
      });
    }
    if (fault === 'unauthorized') {
      return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }), {
        status: 401,
      });
    }

    const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), SIZE - 1);
    const body = FILE.subarray(start, end + 1);

    // Hand it back in small pieces, the way a real socket does.
    const stream = new ReadableStream({
      start(controller) {
        const step = 64 * 1024;
        for (let at = 0; at < body.length; at += step) {
          controller.enqueue(body.subarray(at, Math.min(at + step, body.length)));
        }
        if (fault === 'drop-midway') controller.error(new Error('connection reset'));
        else controller.close();
      },
    });
    return new Response(stream, { status: 206 });
  };

  return state;
}

/** Drives the worker exactly as the page and the browser would. */
async function download(id, { failures } = {}) {
  const bridge = makeBridge({ failures });
  const job = {
    id,
    baseUrl: 'https://bridge.test',
    token: 'tok',
    magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
    infoHash: 'a'.repeat(40),
    fileIndex: 0,
    name: 'film.mkv',
    size: SIZE,
    contentType: 'video/x-matroska',
  };

  handlers.get('message')({ data: { type: 'flai-download', job }, source: { postMessage() {} } });

  let response;
  handlers.get('fetch')({
    request: { url: 'https://app.test/flai/__flai-dl?id=' + id },
    respondWith: (r) => {
      response = r;
    },
  });
  assert.ok(response, 'the worker did not answer the download URL');
  // The response is returned unconsumed: a test asserting that a download *fails* has to be
  // the one that awaits the body, or the rejection escapes this helper instead.
  return { response, bridge };
}

const collect = async (response) => new Uint8Array(await response.arrayBuffer());

test('a clean run returns the file byte for byte', async () => {
  const { response } = await download('clean');
  const out = await collect(response);
  assert.equal(out.length, SIZE);
  assert.deepEqual(out, FILE);
  assert.equal(response.headers.get('Content-Length'), String(SIZE));
  assert.match(response.headers.get('Content-Disposition'), /attachment; filename\*=UTF-8''film\.mkv/);
  assert.equal(response.headers.get('Content-Type'), 'video/x-matroska');
});

/* The whole reason this design was chosen: the free tier spinning down mid-download has to be
 * invisible. The bridge forgets the torrent, answers 409, and the worker hands back the magnet
 * it kept and carries on in the same stream. */
test('survives the bridge forgetting the torrent', async () => {
  const { response, bridge } = await download('forgot', { failures: [null, 'not_active'] });
  assert.deepEqual(await collect(response), FILE, 'file is intact after a 409 not_active');
  assert.equal(bridge.metadataCalls, 1, 'it re-added the torrent exactly once');
});

test('survives a dropped connection in the middle of a slice', async () => {
  const { response } = await download('dropped', { failures: [null, 'drop-midway'] });
  assert.deepEqual(await collect(response), FILE, 'no bytes lost or duplicated across the drop');
});

test('survives the network being gone entirely for a while', async () => {
  const { response } = await download('offline', { failures: ['network', 'network', 'network'] });
  assert.deepEqual(await collect(response), FILE);
});

test('survives 500s and a busy window', async () => {
  const { response } = await download('rough', { failures: [null, 'server', 'busy', 'server'] });
  assert.deepEqual(await collect(response), FILE);
});

/* An expired token cannot be retried into working, so it must stop rather than spin forever. */
test('an expired session fails the download instead of looping', async () => {
  const { response } = await download('expired', { failures: ['unauthorized'] });
  await assert.rejects(response.arrayBuffer(), /session expired/);
});

test('progress is throttled, not sent per network packet', async () => {
  posted.length = 0;
  await collect((await download('progress')).response);
  const running = posted.filter((m) => m.state === 'running');
  // 20 MB at one report per MB, not the ~305 the 64 KB socket chunks would produce.
  assert.ok(running.length <= 21, `expected at most 21 progress messages, got ${running.length}`);
  assert.ok(posted.some((m) => m.state === 'done'), 'it reported completion');
  assert.equal(posted.at(-1).bytes, SIZE);
});
