import type { DownloadManager } from '../download-manager';
import type { Job } from '../idb';
import { formatBytes, formatEta, formatPercent, formatSpeed } from '../format';

interface DownloadsProps {
  manager: DownloadManager;
  jobs: Job[];
  tick: number;
}

const STATUS_BADGE: Record<Job['status'], { className: string; glyph: string; label: string }> = {
  queued: { className: 'n-badge', glyph: '·', label: 'Queued' },
  running: { className: 'n-badge n-badge-brand', glyph: '↓', label: 'Downloading' },
  paused: { className: 'n-badge n-badge-warn', glyph: '‖', label: 'Paused' },
  done: { className: 'n-badge n-badge-ok', glyph: '✓', label: 'Saved' },
  error: { className: 'n-badge n-badge-danger', glyph: '×', label: 'Stopped' },
};

const Row = ({ job, manager, tick }: { job: Job; manager: DownloadManager; tick: number }) => {
  const badge = STATUS_BADGE[job.status];
  const speed = job.status === 'running' ? manager.speedOf(job.id) : 0;
  const left = speed > 0 ? (job.size - job.bytesDone) / speed : Number.NaN;
  // `tick` is not read: it is here so a 1 Hz re-render refreshes speed and ETA, which live
  // outside React state.
  void tick;

  return (
    <li className="n-card n-card-pad n-stack flai-tight flai-job">
      <div className="n-cluster flai-job-head">
        <span className="flai-job-name">{job.name}</span>
        <span className={badge.className}>
          <i className="n-badge-glyph" aria-hidden="true">
            {badge.glyph}
          </i>
          {badge.label}
        </span>
      </div>

      {/* <progress> so the value is in the accessibility tree without maintaining
          aria-valuenow. Indeterminate would be wrong here: we know the proportion exactly. */}
      <progress className="n-progress" value={job.bytesDone} max={job.size || 1} />

      <div className="n-cluster flai-job-meta">
        <span className="flai-job-figure">{formatPercent(job.bytesDone, job.size)}</span>
        <span className="n-hint">
          {formatBytes(job.bytesDone)} of {formatBytes(job.size)}
        </span>
        {job.status === 'running' && (
          <>
            <span className="n-hint">{formatSpeed(speed)}</span>
            <span className="n-hint">{formatEta(left)} left</span>
          </>
        )}
      </div>

      {job.error && (
        <p className="n-error">
          {job.error}
        </p>
      )}

      <div className="n-cluster flai-job-actions">
        {job.status === 'running' && (
          <button type="button" className="n-btn n-btn-sm" onClick={() => manager.pause(job.id)}>
            Pause
          </button>
        )}
        {(job.status === 'paused' || job.status === 'error') && (
          <button
            type="button"
            className="n-btn n-btn-sm n-btn-fill"
            onClick={() => manager.resume(job.id)}
          >
            Resume
          </button>
        )}
        {job.status === 'queued' && (
          <button type="button" className="n-btn n-btn-sm" onClick={() => manager.pause(job.id)}>
            Hold
          </button>
        )}
        <button
          type="button"
          className="n-btn n-btn-sm n-btn-ghost"
          onClick={() => void manager.remove(job.id)}
        >
          {job.status === 'done' ? 'Clear' : 'Cancel'}
        </button>
      </div>
    </li>
  );
};

export const Downloads = ({ manager, jobs, tick }: DownloadsProps) => {
  const resumable = jobs.filter((j) => j.status === 'paused' || j.status === 'error').length;

  if (jobs.length === 0) {
    return (
      <section className="n-card n-card-pad n-stack" aria-labelledby="dl-empty">
        <h2 className="flai-title" id="dl-empty">
          Nothing downloading
        </h2>
        <p className="n-hint">
          Paste a magnet in Browse and pick a file. Downloads land in your save folder, one at a
          time, and resume from the exact byte after a restart.
        </p>
      </section>
    );
  }

  return (
    <>
      {resumable > 0 && (
        <div className="n-note n-note-info">
          <span className="n-note-glyph" aria-hidden="true">
            i
          </span>
          <div className="n-stack flai-tight">
            <div>
              <span className="n-note-title">
                {resumable} download{resumable === 1 ? '' : 's'} paused.
              </span>{' '}
              Resuming needs one click — the browser only grants write access to a file inside a
              real button press, so flai cannot restart these on its own.
            </div>
            <div className="n-cluster">
              <button
                type="button"
                className="n-btn n-btn-sm n-btn-fill"
                onClick={() => manager.resumeAll()}
              >
                Resume all
              </button>
            </div>
          </div>
        </div>
      )}

      <ul className="n-stack flai-jobs">
        {jobs.map((job) => (
          <Row key={job.id} job={job} manager={manager} tick={tick} />
        ))}
      </ul>
    </>
  );
};
