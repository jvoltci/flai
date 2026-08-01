import { useCallback, useEffect, useState } from 'react';
import { bridge, formatBytes, type FileProgress, type TorrentRow } from './bridge';

const POLL_MS = 1200;

/* The verbose view, and the reason the row above it can stay quiet.
 *
 * A torrent client has two audiences at once: someone glancing at whether it is done, and
 * someone working out why it is not. Putting both in one row serves neither. So the row is the
 * glance, and this is everything else — every file with its own progress, and the peer counts
 * behind the single number "12 peers", which hides that 200 others were tried and failed. */
export function Details({ row }: { row: TorrentRow }) {
  const [files, setFiles] = useState<FileProgress[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFiles(await bridge.files(row.id));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [row.id]);

  // Slower than the row above: a file list of 40 rows does not need four updates a second.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const first = useCallback(
    async (index: number, on: boolean) => {
      const current = files?.filter((f) => f.first).map((f) => f.index) ?? [];
      const next = on ? [...new Set([...current, index])] : current.filter((i) => i !== index);
      await bridge.prioritise(row.id, next);
      await load();
    },
    [files, row.id, load]
  );

  if (error) return <p className="flai-bad flai-detail-note">{error}</p>;
  if (!files) return <p className="flai-detail-note">Reading the file list…</p>;

  const { peers } = row;
  return (
    <div className="flai-detail">
      <dl className="flai-peers">
        <div>
          <dt>Connected</dt>
          <dd>{peers.live}</dd>
        </div>
        <div>
          <dt>Connecting</dt>
          <dd>{peers.connecting}</dd>
        </div>
        <div>
          <dt>Queued</dt>
          <dd>{peers.queued}</dd>
        </div>
        <div>
          <dt>Seen</dt>
          <dd>{peers.seen}</dd>
        </div>
        <div>
          <dt>Unreachable</dt>
          <dd>{peers.dead}</dd>
        </div>
        <div>
          <dt>Down</dt>
          <dd>{formatBytes(row.downloadSpeed)}/s</dd>
        </div>
        <div>
          <dt>Up</dt>
          <dd>{formatBytes(row.uploadSpeed)}/s</dd>
        </div>
        <div>
          <dt>Shared</dt>
          <dd>{formatBytes(row.uploadedBytes)}</dd>
        </div>
      </dl>

      {row.priorityCount > 0 && (
        <p className="flai-first-note">
          Fetching {row.priorityCount} file{row.priorityCount === 1 ? '' : 's'} first — the rest
          are paused, and the torrent is slower overall while this lasts. It goes back on its own
          when they finish.{' '}
          <button
            type="button"
            className="n-btn n-btn-sm"
            onClick={() => void bridge.takeEverything(row.id).then(load)}
          >
            Take everything now
          </button>
        </p>
      )}

      <ul className="flai-detail-files">
        {files.map((file) => {
          const pct = file.length > 0 ? (file.done / file.length) * 100 : 0;
          const done = file.done >= file.length;
          return (
            <li key={file.index} className="flai-detail-file" data-off={!file.selected || undefined}>
              <span className="flai-detail-name" title={file.name}>
                {file.name}
              </span>
              <span className="flai-detail-bar">
                <span
                  className="flai-detail-bar-fill"
                  data-done={done || undefined}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </span>
              <span className="flai-detail-size">
                {done ? formatBytes(file.length) : `${formatBytes(file.done)} / ${formatBytes(file.length)}`}
              </span>
              {file.selected && !done ? (
                <button
                  type="button"
                  className={file.first ? 'n-btn n-btn-sm n-btn-fill' : 'n-btn n-btn-sm'}
                  onClick={() => void first(file.index, !file.first)}
                  title={
                    file.first
                      ? 'Stop fetching this one ahead of the others'
                      : 'Get this one first. The rest pause, and the torrent as a whole gets ' +
                        'slower — worth it when you want one episode now.'
                  }
                >
                  First
                </button>
              ) : (
                <span className="flai-detail-state">{done ? '✓' : 'skipped'}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
