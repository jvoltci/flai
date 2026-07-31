import { useState } from 'react';
import type { ApiClient } from '../api';
import type { DownloadManager } from '../download-manager';

interface SettingsProps {
  api: ApiClient;
  manager: DownloadManager;
  onSignedOut: () => void;
}

export const Settings = ({ api, manager, onSignedOut }: SettingsProps) => {
  const [error, setError] = useState<string | null>(null);
  const folder = manager.folderName;

  const pick = async () => {
    setError(null);
    try {
      await manager.chooseFolder();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'could not set the folder');
    }
  };

  return (
    <>
      <section className="n-card n-card-pad n-stack" aria-labelledby="set-folder">
        <div className="n-stack flai-tight">
          <h2 className="flai-title" id="set-folder">
            Save folder
          </h2>
          <p className="n-hint">
            Picked once and remembered. Every download after that lands here with no prompt —
            which is the difference between a downloader and a series of Save As dialogs.
          </p>
        </div>
        <div className="n-cluster">
          <button type="button" className="n-btn n-btn-fill" onClick={() => void pick()}>
            {folder ? 'Change folder' : 'Choose folder'}
          </button>
          {folder ? (
            <span className="n-badge n-badge-ok">
              <i className="n-badge-glyph" aria-hidden="true">
                ✓
              </i>
              {folder}
            </span>
          ) : (
            <span className="n-badge n-badge-warn">
              <i className="n-badge-glyph" aria-hidden="true">
                !
              </i>
              not set — you will be asked for every file
            </span>
          )}
        </div>
        {error && <p className="n-error">{error}</p>}
      </section>

      <section className="n-card n-card-pad n-stack" aria-labelledby="set-session">
        <div className="n-stack flai-tight">
          <h2 className="flai-title" id="set-session">
            Session
          </h2>
          <p className="n-hint">
            Bridge: {api.baseUrl}. The token lives in this tab only and expires after 12 hours;
            closing the tab ends it.
          </p>
        </div>
        <div className="n-cluster">
          <button
            type="button"
            className="n-btn n-btn-danger"
            onClick={() => {
              api.signOut();
              onSignedOut();
            }}
          >
            Sign out
          </button>
        </div>
      </section>

      <section className="n-card n-card-pad n-stack" aria-labelledby="set-limits">
        <div className="n-stack flai-tight">
          <h2 className="flai-title" id="set-limits">
            What this runs on
          </h2>
          <p className="n-hint">
            Written down because the limits are the design, not an accident.
          </p>
        </div>
        <div className="n-table-scroll">
          <table className="n-table">
            <tbody>
              <tr>
                <td className="n-table-key">Downloads at once</td>
                <td>
                  One. The bridge keeps a single sliding window per torrent, so two readers would
                  evict each other&rsquo;s pieces and both would crawl.
                </td>
              </tr>
              <tr>
                <td className="n-table-key">Slice size</td>
                <td>
                  8 MB asked, 16 MB ceiling. The bridge holds 64 MB of pieces in memory and
                  forgets the rest, which is how a 512 MB box streams a 50 GB file.
                </td>
              </tr>
              <tr>
                <td className="n-table-key">Interruptions</td>
                <td>
                  Server restarts, spin-downs and dropped Wi-Fi are retried forever and resume
                  from the exact byte. A browser crash costs the bytes since the last commit,
                  never the whole file.
                </td>
              </tr>
              <tr>
                <td className="n-table-key">Tab</td>
                <td>
                  Has to stay open — it may be minimised or buried. Close it and downloads pause,
                  then resume on your next visit.
                </td>
              </tr>
              <tr>
                <td className="n-table-key">Cold start</td>
                <td>
                  The free tier sleeps after 15 idle minutes and takes about a minute to wake.
                  There is no keep-warm ping: it would burn 730 of the 750 free hours a month.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
