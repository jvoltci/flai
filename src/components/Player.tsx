import { useEffect, useMemo, useState } from 'react';
import type { ApiClient, FileEntry, Metadata, TorrentStats } from '../api';
import { probeFile, playlistBlobUrl, type Verdict } from '../probe';
import { formatBytes, formatSpeed } from '../format';

interface PlayerProps {
  api: ApiClient;
  meta: Metadata;
  file: FileEntry;
  onClose: () => void;
}

const VERDICT_NOTE: Record<Exclude<Verdict['playability'], 'plays'>, string> = {
  partial: 'n-note n-note-warn',
  no: 'n-note n-note-danger',
  unknown: 'n-note n-note-info',
};

const VERDICT_GLYPH: Record<Exclude<Verdict['playability'], 'plays'>, string> = {
  partial: '!',
  no: '×',
  unknown: 'i',
};

export const Player = ({ api, meta, file, onClose }: PlayerProps) => {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [stats, setStats] = useState<TorrentStats | null>(null);

  const streamUrl = useMemo(() => api.streamUrl(meta.infoHash, file.index), [api, meta, file]);

  useEffect(() => {
    let live = true;
    setVerdict(null);
    probeFile(streamUrl, file.contentType).then((v) => {
      if (live) setVerdict(v);
    });
    return () => {
      live = false;
    };
  }, [streamUrl, file.contentType]);

  useEffect(() => api.watch(meta.infoHash, setStats), [api, meta.infoHash]);

  /* Revoked on unmount: a blob URL for a 90-byte playlist is not a leak worth worrying about,
   * but leaving them behind on every file you inspect adds up over a session. */
  const playlistUrl = useMemo(() => playlistBlobUrl(streamUrl, file.name), [streamUrl, file.name]);
  useEffect(() => () => URL.revokeObjectURL(playlistUrl), [playlistUrl]);

  const playsHere = verdict?.playability === 'plays' || verdict?.playability === 'partial';

  return (
    <section className="n-card n-card-pad n-stack flai-tight" aria-label="Player">
      <div className="n-cluster flai-player-head">
        <h2 className="flai-title">{file.name}</h2>
        <button type="button" className="n-btn n-btn-sm n-btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {verdict === null && (
        <span className="n-loading" role="status">
          <span className="n-spinner n-spinner-sm" />
          Reading the file header…
        </span>
      )}

      {verdict && verdict.playability !== 'plays' && (
        <div className={VERDICT_NOTE[verdict.playability]} role="alert">
          <span className="n-note-glyph" aria-hidden="true">
            {VERDICT_GLYPH[verdict.playability]}
          </span>
          <div>
            <span className="n-note-title">
              {verdict.playability === 'no'
                ? 'This browser cannot play this file.'
                : verdict.playability === 'partial'
                  ? 'This will play, but not all of it.'
                  : 'Could not inspect this file.'}
            </span>{' '}
            {verdict.reason}
          </div>
        </div>
      )}

      {playsHere && (
        <video
          className="flai-video"
          controls
          autoPlay
          preload="metadata"
          src={streamUrl}
          // The bridge serves at most 16 MB per request, so seeking works but a jump backwards
          // past the sliding window makes the server restart the torrent — a stall, not a
          // failure. Worth knowing before it looks like a bug.
        >
          Your browser does not support the video element.
        </video>
      )}

      <div className="n-cluster flai-player-meta">
        <span className="n-badge">{formatBytes(file.length)}</span>
        {verdict?.container && verdict.container !== 'unknown' && (
          <span className="n-badge">{verdict.container}</span>
        )}
        {verdict?.codecs.map((codec) => (
          <span key={codec} className="n-badge">
            {codec}
          </span>
        ))}
        {stats?.active && (
          <>
            <span className="n-badge">{stats.numPeers ?? 0} peers</span>
            <span className="n-badge">{formatSpeed(stats.downloadSpeed ?? 0)}</span>
          </>
        )}
        {stats && !stats.active && (
          <span className="n-badge n-badge-warn">
            <i className="n-badge-glyph" aria-hidden="true">
              !
            </i>
            bridge dropped this torrent
          </span>
        )}
      </div>

      <div className="n-cluster">
        <a className="n-btn n-btn-sm" href={playlistUrl} download={`${file.name}.m3u`}>
          Open in VLC / mpv / IINA
        </a>
        <button
          type="button"
          className="n-btn n-btn-sm n-btn-ghost"
          onClick={() => void navigator.clipboard.writeText(streamUrl)}
        >
          Copy stream URL
        </button>
        <p className="n-hint">
          The playlist is a two-line .m3u — opening it hands this exact URL to your desktop
          player, which decodes anything Chrome will not. The URL carries your session token, so
          it stops working when the token expires.
        </p>
      </div>
    </section>
  );
};
