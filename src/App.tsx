import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, type FileEntry, type Metadata } from './api';
import {
  onProgress,
  serviceWorkerSupported,
  startDownload,
  type DownloadStatus,
} from './downloader';
import { Player } from './Player';
import { formatBytes, formatPercent } from './format';

const DEFAULT_API = 'https://flai-api.onrender.com';
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? DEFAULT_API;

/* Every kind carries a glyph as well as a hue. nilam's rule: anything colour-coded needs a
 * second channel, because at hue 285 the status colours collapse under deuteranopia. */
function kindOf(file: FileEntry): { label: string; glyph: string | null; brand: boolean } {
  if (file.contentType.startsWith('video/')) return { label: 'Video', glyph: '▶', brand: true };
  if (file.contentType.startsWith('audio/')) return { label: 'Audio', glyph: '♪', brand: true };
  return { label: 'File', glyph: null, brand: false };
}

/* Fetching metadata means finding peers, so there is no proportion to report and .n-progress
 * would be a lie — but the shape that arrives is always a title and a table of rows, and
 * nilam's loader table says prefer the skeleton wherever the shape is predictable.
 *
 * aria-hidden throughout: the .n-loading beside the button is the live region, and two
 * announcements for one wait means the screen reader says it twice. */
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

const STATE_TEXT: Record<DownloadStatus['state'], string> = {
  starting: 'starting',
  running: 'downloading',
  waking: 'waking the bridge',
  done: 'saved to Downloads',
  error: 'stopped',
  cancelled: 'cancelled',
};

/* Deliberately not a progress bar. Chrome's own download bar already has one, and duplicating
 * it was most of what made the old three-tab version feel heavy. This is one line per file so
 * you can see the bridge is alive — particularly "waking the bridge", which is the free tier
 * cold-starting and the only pause that ever looks like a hang. */
const Activity = ({ items }: { items: DownloadStatus[] }) => {
  if (items.length === 0) return null;
  return (
    <section className="n-card n-card-pad n-stack flai-tight" aria-label="Downloads">
      {items.map((item) => (
        <div key={item.id} className="n-cluster flai-activity" role="status">
          <span className="flai-activity-name">{item.name}</span>
          <span
            className={
              item.state === 'done'
                ? 'n-badge n-badge-ok'
                : item.state === 'error'
                  ? 'n-badge n-badge-danger'
                  : item.state === 'waking'
                    ? 'n-badge n-badge-warn'
                    : 'n-badge n-badge-brand'
            }
          >
            <i className="n-badge-glyph" aria-hidden="true">
              {item.state === 'done' ? '✓' : item.state === 'error' ? '×' : item.state === 'waking' ? '!' : '↓'}
            </i>
            {STATE_TEXT[item.state]}
          </span>
          {item.state === 'running' && (
            <span className="n-hint flai-activity-figure">
              {formatPercent(item.bytes, item.size)} of {formatBytes(item.size)}
            </span>
          )}
          {item.error && <span className="n-hint">{item.error}</span>}
        </div>
      ))}
    </section>
  );
};

export function App() {
  const api = useMemo(() => new ApiClient(apiBaseUrl), []);

  const [signedIn, setSignedIn] = useState(api.signedIn);
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [player, setPlayer] = useState<FileEntry | null>(null);
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);

  useEffect(
    () =>
      onProgress((message) => {
        setDownloads((current) =>
          current.map((item) =>
            item.id === message.id
              ? { ...item, state: message.state, bytes: message.bytes ?? item.bytes, error: message.error }
              : item
          )
        );
      }),
    []
  );

  const signIn = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (signingIn) return;
      setSigningIn(true);
      setSignInError(null);
      try {
        await api.signIn(password);
        setPassword('');
        setSignedIn(true);
      } catch (err) {
        setSignInError(err instanceof Error ? err.message : 'could not sign in');
      } finally {
        setSigningIn(false);
      }
    },
    [api, password, signingIn]
  );

  const fetchFiles = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      // aria-busy stops a second click but not a second Enter inside the field.
      if (busy) return;
      const magnet = url.trim();
      if (!magnet.toLowerCase().startsWith('magnet:')) {
        setUrlInvalid(true);
        return;
      }
      setUrlInvalid(false);
      setBusy(true);
      setError(null);
      setMeta(null);
      setPlayer(null);
      try {
        setMeta(await api.metadata(magnet));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not fetch that torrent');
      } finally {
        setBusy(false);
      }
    },
    [api, busy, url]
  );

  const download = useCallback(
    async (file: FileEntry) => {
      if (!meta) return;
      setError(null);
      try {
        const status = await startDownload({
          apiBaseUrl,
          token: api.token ?? '',
          magnet: url.trim(),
          meta,
          file,
        });
        setDownloads((current) => [status, ...current.filter((d) => d.name !== status.name)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not start that download');
      }
    },
    [api, meta, url]
  );

  const playable = meta ? meta.files.filter((f) => f.streamable).length : 0;

  return (
    <main id="home" className="n-container flai-shell n-stack">
      <header className="n-card n-card-pad n-stack flai-hero">
        <div className="n-stack flai-tight">
          <p className="flai-eyebrow">magnet · stream · straight to downloads</p>
          {/* The page's one --text-display element. */}
          <h1 className="flai-word">
            fl<b>ai</b>
          </h1>
        </div>
        <p className="flai-lede">
          Paste a magnet. flai asks the swarm for the file list, then streams each file into
          your Downloads folder in 8&nbsp;MB slices — retrying through restarts on its own.
        </p>

        {!signedIn ? (
          <form onSubmit={signIn} className="n-stack">
            <div className="n-field">
              <label className="n-label" data-required htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="n-input"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (signInError) setSignInError(null);
                }}
                aria-invalid={signInError ? true : undefined}
                aria-describedby={signInError ? 'password-error' : 'password-hint'}
              />
              {signInError ? (
                <p className="n-error" id="password-error">
                  {signInError}
                </p>
              ) : (
                <p className="n-hint" id="password-hint">
                  Entered once. The bridge is gated so the bandwidth bill stays with whoever
                  runs it.
                </p>
              )}
            </div>
            <div className="n-cluster">
              <button type="submit" className="n-btn n-btn-fill n-btn-lg" aria-busy={signingIn}>
                Sign in
              </button>
              {signingIn && (
                /* The free tier sleeps after 15 idle minutes and takes about a minute to wake,
                   and there is no keep-warm ping — it cost 730 of the 750 free hours a month.
                   So the first sign-in of the day is genuinely slow, and a spinner with no
                   explanation reads as a hang. */
                <span className="n-loading" role="status">
                  <span className="n-spinner n-spinner-sm" />
                  Waking the bridge — the first sign-in of the day takes about a minute…
                </span>
              )}
            </div>
          </form>
        ) : (
          <form onSubmit={fetchFiles} className="n-stack">
            <div className="n-field">
              <label className="n-label" data-required htmlFor="magnet">
                Magnet URI
              </label>
              <input
                id="magnet"
                className="n-input"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="magnet:?xt=urn:btih:…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlInvalid) setUrlInvalid(false);
                }}
                aria-invalid={urlInvalid || undefined}
                aria-describedby={urlInvalid ? 'magnet-error' : 'magnet-hint'}
              />
              {urlInvalid ? (
                /* One text node, no inline markup: .n-error is display:flex, so every child —
                   including each run of text — becomes a flex item with a var(--space-1) gap.
                   A <code> mid-sentence came out with a 4px hole either side. */
                <p className="n-error" id="magnet-error">
                  That is not a magnet URI — it has to start with magnet:?xt=urn:btih:
                </p>
              ) : (
                <p className="n-hint" id="magnet-hint">
                  Info-hash magnets only. flai never sees the file until a peer sends it.
                </p>
              )}
            </div>

            <div className="n-cluster">
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
        )}
      </header>

      {signedIn && !serviceWorkerSupported() && (
        <div className="n-note n-note-danger" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">No service worker support.</span> flai streams
            downloads through one, so downloading will not work in this browser. Playback still
            does.
          </div>
        </div>
      )}

      {busy && <ListSkeleton />}

      {error && (
        <div className="n-note n-note-danger" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">Something went wrong.</span> {error}
          </div>
        </div>
      )}

      <Activity items={downloads} />

      {player && meta && (
        <Player api={api} meta={meta} file={player} onClose={() => setPlayer(null)} />
      )}

      {meta && (
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

          {/* tabindex per nilam's .n-table-scroll note: a region that scrolls with the mouse
              and not with the keyboard fails 2.1.1. */}
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
                {meta.files.map((file) => {
                  const kind = kindOf(file);
                  const playing = player?.index === file.index;
                  return (
                    <tr key={file.index} data-playing={playing ? '' : undefined}>
                      <td className="n-table-key flai-name">{file.name}</td>
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
                      <td className="n-table-num">{formatBytes(file.length)}</td>
                      <td>
                        <div className="n-cluster flai-actions">
                          {file.streamable && (
                            <button
                              type="button"
                              className={playing ? 'n-btn n-btn-sm n-btn-fill' : 'n-btn n-btn-sm'}
                              onClick={() => setPlayer(file)}
                            >
                              <span aria-hidden="true">▶</span>
                              {playing ? 'Playing' : 'Play'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="n-btn n-btn-sm"
                            onClick={() => void download(file)}
                          >
                            Save
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
