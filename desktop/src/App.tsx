import { useCallback, useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Details } from './Details';
import { Settings } from './Settings';
import {
  bridge,
  formatBytes,
  formatEta,
  type FileEntry,
  type TorrentInfo,
  type TorrentRow,
} from './bridge';

const POLL_MS = 800;

/** Rows the user has picked, keyed by file index. Empty means every file. */
type Selection = Set<number>;

/* The same two-tone split the web page uses, so the app reads as the same thing. <b> is here
 * for the colour offset, not for weight — hence font-weight: inherit in the stylesheet. */
function Wordmark() {
  return (
    <h1 className="flai-wordmark">
      fl<b>ai</b>
    </h1>
  );
}

export function App() {
  const [magnet, setMagnet] = useState('');
  const [looking, setLooking] = useState(false);
  const [info, setInfo] = useState<TorrentInfo | null>(null);
  const [picked, setPicked] = useState<Selection>(new Set());
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<TorrentRow[]>([]);
  const [settings, setSettings] = useState(false);
  /** Which rows are expanded. Ids, so the set survives the list reordering under it. */
  const [open_, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    void bridge.getConfig().then((c) => setFolder(c.folder));
  }, [settings]);

  /* Polling, not events. The list is at most a handful of rows and the call is an in-process
   * function behind an IPC hop — cheaper than the machinery to push, and it cannot get stuck
   * out of sync with the engine the way a missed event can. */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await bridge.torrents();
        if (alive) setRows(next);
      } catch {
        /* the engine is still starting up */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const look = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed.toLowerCase().startsWith('magnet:')) {
        setError('That does not look like a magnet link.');
        return;
      }
      setLooking(true);
      setError(null);
      setInfo(null);
      try {
        const found = await bridge.inspect(trimmed);
        setInfo(found);
        setPicked(new Set());
      } catch (err) {
        setError(String(err));
      } finally {
        setLooking(false);
      }
    },
    []
  );

  const chooseFolder = useCallback(async () => {
    const chosen = await open({ directory: true, defaultPath: folder || undefined });
    if (typeof chosen === 'string') setFolder(chosen);
  }, [folder]);

  const download = useCallback(async () => {
    if (!info) return;
    setError(null);
    try {
      await bridge.start(magnet.trim(), [...picked].sort((a, b) => a - b), folder || null);
      setInfo(null);
      setMagnet('');
      setPicked(new Set());
    } catch (err) {
      setError(String(err));
    }
  }, [info, magnet, picked, folder]);

  const toggle = useCallback((index: number) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const chosenBytes = useMemo(() => {
    if (!info) return 0;
    if (picked.size === 0) return info.total;
    return info.files.reduce((sum, f) => (picked.has(f.index) ? sum + f.length : sum), 0);
  }, [info, picked]);

  return (
    <div className="flai-app">
      <header className="flai-top">
        <Wordmark />
        <span className="flai-sub">saves straight to your disk</span>
        <button
          type="button"
          className="n-btn n-btn-sm flai-gear"
          onClick={() => setSettings((on) => !on)}
          aria-pressed={settings}
        >
          Settings
        </button>
      </header>

      {settings && <Settings onClose={() => setSettings(false)} />}

      <form
        className="flai-command"
        onSubmit={(event) => {
          event.preventDefault();
          if (!looking) void look(magnet);
        }}
      >
        <input
          className="n-input"
          value={magnet}
          onChange={(event) => setMagnet(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (pasted.trim().toLowerCase().startsWith('magnet:')) {
              event.preventDefault();
              setMagnet(pasted.trim());
              void look(pasted);
            }
          }}
          placeholder="Paste a magnet link"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" className="n-btn n-btn-fill" aria-busy={looking} disabled={looking}>
          {looking ? 'Looking…' : 'Look'}
        </button>
      </form>

      {error && (
        <p className="n-note n-note-bad flai-error" role="alert">
          {error}
        </p>
      )}

      {info && (
        <section className="flai-panel">
          <div className="flai-panel-head">
            <div>
              <h2 className="flai-panel-title">{info.name}</h2>
              <p className="flai-panel-sub">
                {info.files.length} file{info.files.length === 1 ? '' : 's'} ·{' '}
                {formatBytes(info.total)}
              </p>
            </div>
            <div className="n-cluster">
              <button type="button" className="n-btn n-btn-sm" onClick={() => void chooseFolder()}>
                Folder…
              </button>
              <button type="button" className="n-btn n-btn-fill" onClick={() => void download()}>
                Download {picked.size === 0 ? 'all' : `${picked.size}`} ·{' '}
                {formatBytes(chosenBytes)}
              </button>
            </div>
          </div>

          <p className="flai-folder" title={folder}>
            → {folder}
          </p>

          <ul className="flai-files">
            {info.files.map((file: FileEntry) => {
              const on = picked.size === 0 || picked.has(file.index);
              return (
                <li key={file.index}>
                  <label className={on ? 'flai-file flai-file-on' : 'flai-file'}>
                    <input
                      type="checkbox"
                      checked={picked.has(file.index)}
                      onChange={() => toggle(file.index)}
                    />
                    <span className="flai-file-name">{file.name}</span>
                    <span className="flai-file-size">{formatBytes(file.length)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {picked.size === 0 && (
            <p className="flai-hint">Nothing ticked means everything. Tick to pick.</p>
          )}
        </section>
      )}

      <section className="flai-list">
        {rows.length === 0 && !info && (
          <p className="flai-empty">
            Nothing downloading. Paste a magnet above — files land in a folder you choose, at full
            speed, and carry on where they left off if you close the app.
          </p>
        )}
        {rows.map((row) => (
          <Download
            key={row.id}
            row={row}
            open={open_.has(row.id)}
            onToggle={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(row.id)) next.delete(row.id);
                else next.add(row.id);
                return next;
              })
            }
          />
        ))}
      </section>
    </div>
  );
}

/* Two platforms, two right answers.
 *
 * A desktop has a file manager, so "Show" reveals the folder in Finder or Explorer. Android has
 * no such thing, so the useful action is handing the file to whatever app can play it — which
 * is also why flai contains no video player: the content is HEVC with EAC3, a WebView cannot
 * play it, and VLC on the same phone can. */
async function reveal(path: string) {
  try {
    await revealItemInDir(path);
  } catch {
    await bridge.openDownload(path);
  }
}

function Download({
  row,
  open,
  onToggle,
}: {
  row: TorrentRow;
  open: boolean;
  onToggle: () => void;
}) {
  const percent = row.totalBytes > 0 ? (row.progressBytes / row.totalBytes) * 100 : 0;
  const paused = row.state === 'paused';
  const broken = row.state === 'error';

  return (
    <article className="flai-item" data-state={row.state} data-done={row.finished || undefined}>
      <div className="flai-item-head">
        <button
          type="button"
          className="flai-item-name"
          title={row.name}
          onClick={onToggle}
          aria-expanded={open}
        >
          <span aria-hidden="true" className="flai-caret" data-open={open || undefined}>
            ›
          </span>
          {row.name}
        </button>
        <span className="flai-item-pct">
          {row.finished ? 'Done' : `${percent.toFixed(percent < 10 ? 1 : 0)}%`}
        </span>
      </div>

      <div className="flai-bar" role="progressbar" aria-valuenow={Math.round(percent)}>
        <div className="flai-bar-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>

      <div className="flai-item-foot">
        <span>
          {formatBytes(row.progressBytes)} of {formatBytes(row.totalBytes)}
        </span>
        {broken ? (
          <span className="flai-bad">{row.error ?? 'failed'}</span>
        ) : row.finished ? (
          <span>seeding · ↑ {formatBytes(row.uploadSpeed)}/s</span>
        ) : paused ? (
          <span>paused</span>
        ) : (
          <span>
            ↓ {formatBytes(row.downloadSpeed)}/s · {row.peers.live} peer
            {row.peers.live === 1 ? '' : 's'} · {formatEta(row.etaSeconds)}
            {row.priorityCount > 0 && ` · ${row.priorityCount} first`}
          </span>
        )}
        <span className="n-cluster flai-item-actions">
          {!row.finished && !broken && (
            <button
              type="button"
              className="n-btn n-btn-sm"
              onClick={() => void (paused ? bridge.resume(row.id) : bridge.pause(row.id))}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            type="button"
            className={row.finished ? 'n-btn n-btn-sm n-btn-fill' : 'n-btn n-btn-sm'}
            onClick={() => void reveal(row.outputFolder)}
            title={
              row.finished
                ? 'Open it in whatever player or viewer you already have'
                : 'Show the folder it is downloading into'
            }
          >
            {row.finished ? 'Open' : 'Show'}
          </button>
          <button
            type="button"
            className="n-btn n-btn-sm"
            onClick={() => void bridge.forget(row.id, false)}
            title="Removes it from this list and leaves the files where they are"
          >
            Remove
          </button>
        </span>
      </div>

      {open && <Details row={row} />}
    </article>
  );
}
