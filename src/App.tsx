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

interface PlayerState {
  infoHash: string;
  fileIndex: number;
  name: string;
}

interface ListProps {
  meta: Metadata;
  api: ApiClient;
  onPlay: (file: FileEntry) => void;
}

const List = ({ meta, api, onPlay }: ListProps) => (
  <ul className="ulist">
    <ul className="vlist">
      {meta.files.map((f) => (
        <li key={f.index} className="litem">
          <a className="link" href={api.fileUrl(meta.infoHash, f.index, true)}>
            {f.name}
          </a>
          {f.streamable && (
            <button type="button" className="play-btn" onClick={() => onPlay(f)} title="play in browser">
              ▶
            </button>
          )}
          <span className="file-meta">{formatBytes(f.length)}</span>
        </li>
      ))}
    </ul>
  </ul>
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
      if (url.trim().substring(0, 6).toLowerCase() === 'magnet') {
        setList(0);
        setMagnetSubmit(1);
        setPlayer(null);
        handleTorrent(url.trim(), password);
      } else {
        // Non-magnet URL — keep prior behavior (no-op, hide list).
        setList(0);
      }
    },
    [url, password, handleTorrent]
  );

  const handlePlay = useCallback((file: FileEntry) => {
    if (!meta) return;
    setPlayer({ infoHash: meta.infoHash, fileIndex: file.index, name: file.name });
  }, [meta]);

  return (
    <div id="home" className="container">
      <h3 id="u1">
        Welcome To fl<span id="u11">ai</span> Downloads
      </h3>
      <div className="row">
        <div className="col-md-12" style={{ textAlign: 'center' }}>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <input
                onChange={(e) => setUrl(e.target.value)}
                type="text"
                name="user[url]"
                required
                className="form-control"
                placeholder="Downloadable URL | Magnet URI"
                id="u2"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                name="user[password]"
                required
                className="form-control"
                placeholder="Password"
                id="u3"
                autoComplete="current-password"
              />
              <p />
              <button id="buttonS" type="submit" className="btn btn-danger btn-lg">
                Download
              </button>
            </div>
          </form>

          {magnetSubmit === 1 && <div className="lds-hourglass" />}
          {magnetSubmit === 2 && <div className="error">{errorMsg}</div>}

          {list === 1 && meta && (
            <>
              <div className="meta-head">
                <strong>{meta.name}</strong> · {formatBytes(meta.size)}
              </div>
              <List meta={meta} api={api} onPlay={handlePlay} />
              <div className="zip-row">
                <a className="btn btn-outline-danger btn-sm" href={api.zipUrl(meta.infoHash)}>
                  Download all (.zip)
                </a>
              </div>
            </>
          )}

          {player && meta && (
            <div className="player-wrap">
              <h4>{player.name}</h4>
              <video controls autoPlay src={api.fileUrl(player.infoHash, player.fileIndex)}>
                Your browser does not support the video element.
              </video>
              <button type="button" className="player-close" onClick={() => setPlayer(null)}>
                close player
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
