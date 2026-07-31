import { useCallback, useState } from 'react';
import type { ApiClient, FileEntry, Metadata } from '../api';
import type { DownloadManager } from '../download-manager';
import { formatBytes } from '../format';

interface BrowseProps {
  api: ApiClient;
  manager: DownloadManager;
  onPlay: (meta: Metadata, file: FileEntry) => void;
  onQueued: () => void;
}

/* Fetching metadata means finding peers, so there is no proportion to report and .n-progress
 * would be a lie — but the shape that arrives is always a title and a table of rows, and
 * nilam's loader table says prefer the skeleton wherever the shape is predictable. The .n-bar
 * on top carries the "something is happening, duration unknown" half.
 *
 * aria-hidden on the whole thing: the .n-loading beside the button is the live region, and two
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

/* Every kind carries a glyph as well as a hue. nilam's rule: anything colour-coded needs a
 * second channel, because at hue 285 the status colours collapse under deuteranopia. */
function kindOf(file: FileEntry): { label: string; glyph: string | null; brand: boolean } {
  if (file.contentType.startsWith('video/')) return { label: 'Video', glyph: '▶', brand: true };
  if (file.contentType.startsWith('audio/')) return { label: 'Audio', glyph: '♪', brand: true };
  return { label: 'File', glyph: null, brand: false };
}

export const Browse = ({ api, manager, onPlay, onQueued }: BrowseProps) => {
  const [url, setUrl] = useState('');
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  const submit = useCallback(
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

  const download = async (file: FileEntry) => {
    if (!meta) return;
    setQueueError(null);
    try {
      await manager.enqueue(url.trim(), meta, file);
      onQueued();
    } catch (err) {
      // The commonest case by far: the folder or file picker was dismissed.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setQueueError(err instanceof Error ? err.message : 'could not start that download');
    }
  };

  const playable = meta ? meta.files.filter((f) => f.streamable).length : 0;

  return (
    <>
      <section className="n-card n-card-pad n-stack" aria-labelledby="browse-title">
        <div className="n-stack flai-tight">
          <h2 className="flai-title" id="browse-title">
            Add a magnet
          </h2>
          <p className="n-hint">
            flai asks the swarm for the file list, then downloads in 8 MB slices straight to your
            disk — resumable, and it never buffers the whole file anywhere.
          </p>
        </div>

        <form onSubmit={submit} className="n-stack">
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
              <span className="n-loading" role="status">
                <span className="n-spinner n-spinner-sm" />
                Asking the swarm for metadata…
              </span>
            )}
          </div>
        </form>
      </section>

      {busy && <ListSkeleton />}

      {error && (
        <div className="n-note n-note-danger" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">Could not fetch that torrent.</span> {error}
          </div>
        </div>
      )}

      {queueError && (
        <div className="n-note n-note-danger" role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            ×
          </span>
          <div>
            <span className="n-note-title">Could not queue that file.</span> {queueError}
          </div>
        </div>
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
              {!manager.folderName && (
                <span className="n-badge n-badge-warn">
                  <i className="n-badge-glyph" aria-hidden="true">
                    !
                  </i>
                  no save folder — you will be asked per file
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
                  return (
                    <tr key={file.index}>
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
                              className="n-btn n-btn-sm"
                              onClick={() => onPlay(meta, file)}
                            >
                              <span aria-hidden="true">▶</span> Play
                            </button>
                          )}
                          <button
                            type="button"
                            className="n-btn n-btn-sm n-btn-fill"
                            onClick={() => void download(file)}
                          >
                            Download
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
    </>
  );
};
