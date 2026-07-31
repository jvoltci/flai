import { useCallback, useMemo, useState } from 'react';
import { ApiClient, type FileEntry, type Metadata } from './api';

const DEFAULT_API = 'https://flai-api.onrender.com';
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? DEFAULT_API;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* The API's `streamable` flag covers audio as well as video (see flai-api's isStreamable),
 * so the badge reads the contentType instead of guessing from the flag. Every variant
 * carries a glyph as well as a hue: prove.mjs reports that at hue 285 the status colours
 * collapse under deuteranopia, and nilam's rule is that anything colour-coded gets a
 * second channel. "Video" is not a status, but the rule is cheap to keep. */
function kindOf(f: FileEntry): { label: string; glyph: string | null; brand: boolean } {
  if (f.contentType.startsWith('video/')) return { label: 'Video', glyph: '▶', brand: true };
  if (f.contentType.startsWith('audio/')) return { label: 'Audio', glyph: '♪', brand: true };
  return { label: 'File', glyph: null, brand: false };
}

interface PlayerState {
  infoHash: string;
  fileIndex: number;
  name: string;
}

/* Loading, and the choice between the two loaders is deliberate.
 *
 * nilam's loader table: .n-bar means "something is happening, duration unknown, panel
 * width"; .n-skeleton means "content shaped like THIS is coming", and the docs say prefer
 * the skeleton wherever the shape is predictable. Fetching torrent metadata means finding
 * peers, so there is no proportion to report and .n-progress would be a lie — but the shape
 * that arrives is always a title and a table of file rows, so that part is a skeleton.
 * Four rows is a guess at the length, not at the layout.
 *
 * aria-hidden on the whole section, and nilam's `role="progressbar"` deliberately left off the
 * bar: the .n-loading role="status" next to the submit button is what announces this, and two
 * live regions for one wait means the screen reader says it twice. */
const ListSkeleton = () => (
  <section className="n-card n-card-pad n-stack flai-loading-card" aria-hidden="true">
    <div className="n-bar" />
    <div className="n-skeleton flai-skeleton-title" />
    <div className="n-stack flai-skeleton-list">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="n-cluster">
          <div className="n-skeleton flai-skeleton-row flai-skeleton-name" />
          <div className="n-skeleton flai-skeleton-row flai-skeleton-size" />
        </div>
      ))}
    </div>
  </section>
);

interface ListProps {
  meta: Metadata;
  api: ApiClient;
  playingIndex: number | null;
  onPlay: (file: FileEntry) => void;
}

const List = ({ meta, api, playingIndex, onPlay }: ListProps) => (
  /* tabindex on the scroll container, per nilam's .n-table-scroll note — a region that
     scrolls with the mouse and not with the keyboard fails 2.1.1. */
  <div className="n-table-scroll flai-files" tabIndex={0}>
    <table className="n-table">
      <thead>
        <tr>
          <th>File</th>
          <th>Kind</th>
          <th className="flai-th-num">Size</th>
          <th>
            <span className="n-sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {meta.files.map((f) => {
          const kind = kindOf(f);
          const playing = playingIndex === f.index;
          return (
            <tr key={f.index} data-playing={playing ? '' : undefined}>
              <td className="n-table-key flai-name">{f.name}</td>
              <td>
                <span className={kind.brand ? 'n-badge n-badge-brand' : 'n-badge'}>
                  {kind.glyph && (
                    <i className="n-badge-glyph" aria-hidden="true">
                      {kind.glyph}
                    </i>
                  )}
                  {kind.label}
                </span>
              </td>
              <td className="n-table-num">{formatBytes(f.length)}</td>
              <td>
                <div className="n-cluster flai-actions">
                  {f.streamable && (
                    /* The affordance the old ▶ text button did not have: a real control
                       with a label. .n-btn-fill only on the row that is playing, so the
                       glow marks state rather than repeating on every row. */
                    <button
                      type="button"
                      className={playing ? 'n-btn n-btn-sm n-btn-fill' : 'n-btn n-btn-sm'}
                      onClick={() => onPlay(f)}
                    >
                      <span aria-hidden="true">▶</span>
                      {playing ? 'Playing' : 'Play'}
                    </button>
                  )}
                  <a className="n-btn n-btn-sm" href={api.fileUrl(meta.infoHash, f.index, true)}>
                    Save
                  </a>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export function App() {
  const api = useMemo(() => new ApiClient(apiBaseUrl), []);
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [meta, setMeta] = useState<Metadata | null>(null);
  // 0 = idle, 1 = loading, 2 = error
  const [magnetSubmit, setMagnetSubmit] = useState<0 | 1 | 2>(0);
  const [list, setList] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string>('Oops! Something went wrong.');
  const [player, setPlayer] = useState<PlayerState | null>(null);
  // Client-side "that is not a magnet". Was a silent no-op — see handleSubmit.
  const [urlInvalid, setUrlInvalid] = useState(false);

  const busy = magnetSubmit === 1;

  const handleTorrent = useCallback(
    async (magnet: string, pass: string) => {
      try {
        const result = await api.metadata(magnet, pass);
        setMeta(result);
        setList(1);
        setMagnetSubmit(0);
      } catch (err) {
        setErrorMsg((err as Error).message || 'Oops! Something went wrong.');
        setMagnetSubmit(2);
        console.error('Error:', err);
      }
    },
    [api]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      // aria-busy sets pointer-events:none on the button, which stops a second click but
      // not a second Enter keypress inside a field. Guard the handler instead.
      if (busy) return;
      const magnet = url.trim();
      if (magnet.substring(0, 6).toLowerCase() !== 'magnet') {
        /* Was `setList(0)` and nothing else: submitting a non-magnet URL hid the list and
           gave no reason, so the app looked broken. Now it is a field-level .n-error, which
           carries a ⚠ as well as the danger hue — the whole point of nilam is that a status
           which collapses under dichromacy needs a second channel. */
        setUrlInvalid(true);
        setList(0);
        return;
      }
      setUrlInvalid(false);
      setList(0);
      setMagnetSubmit(1);
      setPlayer(null);
      handleTorrent(magnet, password);
    },
    [url, password, handleTorrent, busy]
  );

  const handlePlay = useCallback(
    (file: FileEntry) => {
      if (!meta) return;
      setPlayer({ infoHash: meta.infoHash, fileIndex: file.index, name: file.name });
    },
    [meta]
  );

  const playable = meta ? meta.files.filter((f) => f.streamable).length : 0;

  return (
    <main id="home" className="n-container flai-shell n-stack">
      <header className="n-card n-card-pad n-stack flai-hero">
        <div className="n-stack flai-tight">
          <p className="flai-eyebrow">magnet · stream · no install</p>
          {/* The page's one --text-display element. */}
          <h1 className="flai-word">
            fl<b>ai</b>
          </h1>
        </div>
        <p className="flai-lede">
          Paste a magnet link. flai asks the swarm for the file list, then streams video
          straight into the page — seeking included, before the download has finished.
        </p>

        <form onSubmit={handleSubmit} className="n-stack">
          <div className="n-field">
            <label className="n-label" data-required htmlFor="magnet">
              Magnet URI
            </label>
            <input
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlInvalid) setUrlInvalid(false);
              }}
              type="text"
              name="user[url]"
              required
              className="n-input"
              placeholder="magnet:?xt=urn:btih:…"
              id="magnet"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={urlInvalid || undefined}
              aria-describedby={urlInvalid ? 'magnet-error' : 'magnet-hint'}
            />
            {urlInvalid ? (
              /* One text node, no inline markup. .n-error is display:flex, so every child —
                 including each run of text — becomes a separate flex item with a
                 var(--space-1) gap. A <code> in the middle of this sentence came out with a
                 4px hole either side of it. Same trap nilam documents on .n-summary. */
              <p className="n-error" id="magnet-error">
                That is not a magnet URI — it has to start with magnet:?xt=urn:btih:
              </p>
            ) : (
              <p className="n-hint" id="magnet-hint">
                Info-hash magnets only. flai never sees the file until a peer sends it.
              </p>
            )}
          </div>

          <div className="n-field">
            <label className="n-label" data-required htmlFor="password">
              Password
            </label>
            <input
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              name="user[password]"
              required
              className="n-input"
              placeholder="••••••••"
              id="password"
              autoComplete="current-password"
              aria-describedby="password-hint"
            />
            <p className="n-hint" id="password-hint">
              flai-api is gated, so the bandwidth bill stays with whoever runs it.
            </p>
          </div>

          <div className="n-cluster">
            {/* aria-busy is nilam's loading contract on a button: it keeps the label's width
                so the row does not reflow, swaps in a spinner, and is the accessible signal
                at the same time. */}
            <button type="submit" className="n-btn n-btn-fill n-btn-lg" aria-busy={busy}>
              Fetch files
            </button>
            {busy && (
              /* role="status" carries an implicit aria-live="polite", so this is announced
                 once. The spinner beside it is the decorative half of the pair. */
              <span className="n-loading" role="status">
                <span className="n-spinner n-spinner-sm" />
                Asking the swarm for metadata…
              </span>
            )}
          </div>
        </form>
      </header>

      {busy && <ListSkeleton />}

      {magnetSubmit === 2 && (
        /* Was `.error { color: red }` with no glyph — a status that vanishes for a
           deuteranope, in the first app to use the system that proves that cannot happen.
           .n-note-danger carries the × glyph and role="alert" announces it. */
        <div className="n-note n-note-danger" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">Could not fetch that torrent.</span> {errorMsg}
          </div>
        </div>
      )}

      {player && (
        <section className="n-card n-card-pad n-stack flai-tight" aria-label="Video player">
          <div className="n-cluster flai-player-head">
            <h2 className="flai-title">{player.name}</h2>
            <button type="button" className="n-btn n-btn-sm n-btn-ghost" onClick={() => setPlayer(null)}>
              Close
            </button>
          </div>
          <video className="flai-video" controls autoPlay src={api.fileUrl(player.infoHash, player.fileIndex)}>
            Your browser does not support the video element.
          </video>
        </section>
      )}

      {list === 1 && meta && (
        <section className="n-card n-card-pad n-stack" aria-labelledby="torrent-name">
          <div className="n-stack flai-tight">
            <h2 className="flai-title" id="torrent-name">
              {meta.name}
            </h2>
            <div className="n-cluster">
              <span className="n-badge">{formatBytes(meta.size)}</span>
              <span className="n-badge">
                {meta.files.length} file{meta.files.length === 1 ? '' : 's'}
              </span>
              {playable > 0 && (
                <span className="n-badge n-badge-brand">
                  <i className="n-badge-glyph" aria-hidden="true">
                    ▶
                  </i>
                  {playable} playable
                </span>
              )}
            </div>
          </div>

          <List meta={meta} api={api} playingIndex={player?.fileIndex ?? null} onPlay={handlePlay} />

          <div className="n-cluster">
            <a className="n-btn" href={api.zipUrl(meta.infoHash)}>
              Download all (.zip)
            </a>
            <p className="n-hint">Zipped on the fly — nothing is stored server-side.</p>
          </div>
        </section>
      )}
    </main>
  );
}
