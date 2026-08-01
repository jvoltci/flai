import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, type FileEntry, type Metadata } from './api';
import { Player } from './Player';
import { formatBytes } from './format';

const DEFAULT_API = 'https://flai-api.onrender.com';
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? DEFAULT_API;

/** How long a Save button stays acknowledged. Long enough to notice, short enough to re-click. */
const STARTED_MS = 8000;
/** Below this a filter box is noise; above it, a file list is a wall. */
const FILTER_THRESHOLD = 8;

/* Every kind carries a glyph as well as a hue. nilam's rule: anything colour-coded needs a
 * second channel, because at hue 285 the status colours collapse under deuteranopia. */
function kindOf(file: FileEntry): { label: string; glyph: string | null; brand: boolean } {
  if (file.contentType.startsWith('video/')) return { label: 'Video', glyph: '▶', brand: true };
  if (file.contentType.startsWith('audio/')) return { label: 'Audio', glyph: '♪', brand: true };
  return { label: 'File', glyph: null, brand: false };
}

/* Metadata means finding peers, so there is no proportion to report and .n-progress would be a
 * lie — but the shape that arrives is always a title and a table of rows, and nilam's loader
 * table says prefer the skeleton wherever the shape is predictable.
 *
 * aria-hidden throughout: the .n-loading next to the field is the live region, and two
 * announcements for one wait means the screen reader says it twice. */
const ListSkeleton = () => (
  <section className="n-card n-card-pad n-stack flai-loading-card flai-rise" aria-hidden="true">
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
  const [filter, setFilter] = useState('');
  const [started, setStarted] = useState<number[]>([]);

  const magnetRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // The one field on the page should not need a click to reach.
  useEffect(() => {
    (signedIn ? magnetRef : passwordRef).current?.focus();
  }, [signedIn]);

  // Escape closes the player, the way every other overlay on the web does.
  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlayer(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [player]);

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

  /* Takes the magnet as an argument rather than reading state, so the paste handler can load
   * the pasted value immediately instead of waiting a render for setUrl to land. */
  const load = useCallback(
    async (magnet: string) => {
      if (busy) return;
      if (!magnet.toLowerCase().startsWith('magnet:')) {
        setUrlInvalid(true);
        return;
      }
      setUrlInvalid(false);
      setBusy(true);
      setError(null);
      setMeta(null);
      setPlayer(null);
      setFilter('');
      setStarted([]);
      try {
        setMeta(await api.metadata(magnet));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not fetch that torrent');
      } finally {
        setBusy(false);
      }
    },
    [api, busy]
  );

  /* The entire interaction is "paste a magnet", so pasting one is the whole interaction. */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = event.clipboardData.getData('text').trim();
      if (!pasted.toLowerCase().startsWith('magnet:')) return;
      event.preventDefault();
      setUrl(pasted);
      void load(pasted);
    },
    [load]
  );

  const onSave = useCallback((file: FileEntry) => {
    /* An <a download> gives the page no signal at all, and Chrome's download bar may well be
     * collapsed — so clicking Save looked like nothing happening. This is the acknowledgement. */
    setStarted((current) => [...new Set([...current, file.index])]);
    setTimeout(() => {
      setStarted((current) => current.filter((i) => i !== file.index));
    }, STARTED_MS);
  }, []);

  const playable = meta ? meta.files.filter((f) => f.streamable).length : 0;
  const needle = filter.trim().toLowerCase();
  const visible = meta
    ? needle
      ? meta.files.filter((f) => f.name.toLowerCase().includes(needle))
      : meta.files
    : [];

  /* Two states, and the difference is the point. With nothing loaded the page is one wordmark
   * and one field, held in the middle of the screen. The moment a torrent lands it lifts to the
   * top and the results take the space. */
  const settled = Boolean(meta || busy || error);

  return (
    <main id="home" className="n-container flai-shell" data-state={settled ? 'results' : 'idle'}>
      <div className="flai-hero flai-rise">
        {/* The page's one --text-display element. */}
        <h1 className="flai-word">
          fl<b>ai</b>
        </h1>

        {!signedIn ? (
          <form onSubmit={signIn} className="flai-ask">
            <div className="flai-command">
              <label className="n-sr-only" htmlFor="password">
                Password
              </label>
              <input
                ref={passwordRef}
                id="password"
                className="n-input flai-command-input"
                type="password"
                required
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (signInError) setSignInError(null);
                }}
                aria-invalid={signInError ? true : undefined}
                aria-describedby={signInError ? 'password-error' : undefined}
              />
              <button
                type="submit"
                className="n-btn n-btn-fill flai-command-go"
                aria-busy={signingIn}
              >
                Enter
              </button>
            </div>
            {signInError && (
              <p className="n-error flai-centred" id="password-error">
                {signInError}
              </p>
            )}
            {signingIn && (
              /* The free tier sleeps after 15 idle minutes and takes about a minute to wake,
                 and there is no keep-warm ping — it cost 730 of the 750 free hours a month.
                 A spinner with no explanation reads as a hang. */
              <p className="n-loading flai-centred" role="status">
                <span className="n-spinner n-spinner-sm" />
                Waking the bridge — this takes about a minute
              </p>
            )}
          </form>
        ) : (
          <form
            className="flai-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void load(url.trim());
            }}
          >
            <div className="flai-command">
              <label className="n-sr-only" htmlFor="magnet">
                Magnet URI
              </label>
              <input
                ref={magnetRef}
                id="magnet"
                className="n-input flai-command-input"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="magnet:?xt=urn:btih:…"
                value={url}
                onPaste={onPaste}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlInvalid) setUrlInvalid(false);
                }}
                aria-invalid={urlInvalid || undefined}
                aria-describedby={urlInvalid ? 'magnet-error' : undefined}
              />
              <button type="submit" className="n-btn n-btn-fill flai-command-go" aria-busy={busy}>
                Fetch
              </button>
            </div>

            {urlInvalid ? (
              /* One text node, no inline markup: .n-error is display:flex, so every run of text
                 becomes a flex item with a var(--space-1) gap. */
              <p className="n-error flai-centred" id="magnet-error">
                That is not a magnet link
              </p>
            ) : busy ? (
              <p className="n-loading flai-centred" role="status">
                <span className="n-spinner n-spinner-sm" />
                Asking the swarm
              </p>
            ) : (
              !settled && <p className="n-hint flai-centred">Paste to load</p>
            )}
          </form>
        )}
      </div>

      {busy && <ListSkeleton />}

      {error && (
        <div className="n-note n-note-danger flai-rise" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">Could not load that.</span> {error}
          </div>
        </div>
      )}

      {player && meta && (
        <Player api={api} meta={meta} file={player} onClose={() => setPlayer(null)} />
      )}

      {meta && (
        <section
          className="n-card n-card-pad n-stack flai-tight flai-rise"
          aria-labelledby="torrent-name"
        >
          <div className="flai-results-head">
            <div className="n-stack flai-tighter">
              <h2 className="flai-title" id="torrent-name">
                {meta.name}
              </h2>
              {/* One quiet line instead of three badges. Badges shout, and these are reference
                  figures you glance at, not statuses you act on. */}
              <p className="flai-meta-line">
                <span className="n-num">{formatBytes(meta.size)}</span>
                <span aria-hidden="true"> · </span>
                <span className="n-num">
                  {meta.files.length} file{meta.files.length === 1 ? '' : 's'}
                </span>
                {playable > 0 && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="n-num flai-playable">{playable} playable</span>
                  </>
                )}
              </p>
            </div>
            {meta.files.length > FILTER_THRESHOLD && (
              <div className="n-field flai-filter">
                <label className="n-sr-only" htmlFor="file-filter">
                  Filter files by name
                </label>
                <input
                  id="file-filter"
                  className="n-input n-input-sm"
                  type="search"
                  placeholder="Filter…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* tabindex per nilam's .n-table-scroll note: a region that scrolls with the mouse and
              not with the keyboard fails 2.1.1. */}
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
                {visible.map((file) => {
                  const kind = kindOf(file);
                  const playing = player?.index === file.index;
                  const justStarted = started.includes(file.index);
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
                          <a
                            className={
                              justStarted
                                ? 'n-btn n-btn-sm n-btn-ok flai-pop'
                                : 'n-btn n-btn-sm'
                            }
                            href={api.downloadUrl(meta.infoHash, file.index, url.trim())}
                            download={file.name}
                            onClick={() => onSave(file)}
                          >
                            {justStarted ? (
                              <>
                                <span aria-hidden="true">✓</span> Started
                              </>
                            ) : (
                              'Save'
                            )}
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="flai-empty">
                      Nothing matches “{filter}”
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
