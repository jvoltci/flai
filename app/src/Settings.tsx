import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { bridge, type Config } from './bridge';

/* Three settings, and a way back.
 *
 * Everything else a torrent client usually exposes — port ranges, DHT toggles, peer ceilings —
 * is a knob whose right answer is "leave it alone", and a screen full of those is how people
 * break their own client and then cannot tell what they changed. Reset exists for the times
 * they do it anyway. */
export function Settings({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge.getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  // Escape closes it, the way every other overlay does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = useCallback(async (next: Config) => {
    try {
      setConfig(await bridge.setConfig(next));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  if (!config) return null;

  return (
    <section className="flai-panel flai-settings" aria-label="Settings">
      <div className="flai-panel-head">
        <h2 className="flai-panel-title">Settings</h2>
        <div className="n-cluster">
          {saved && <span className="flai-saved-flash">Saved</span>}
          <button
            type="button"
            className="n-btn n-btn-sm"
            onClick={() => void bridge.resetConfig().then(setConfig)}
          >
            Reset to defaults
          </button>
          <button type="button" className="n-btn n-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {error && <p className="flai-bad flai-detail-note">{error}</p>}

      <label className="flai-setting">
        <span className="flai-setting-label">Save downloads to</span>
        <span className="n-cluster flai-setting-row">
          <input className="n-input flai-setting-path" readOnly value={config.folder} />
          <button
            type="button"
            className="n-btn n-btn-sm"
            onClick={async () => {
              const chosen = await open({ directory: true, defaultPath: config.folder });
              if (typeof chosen === 'string') void apply({ ...config, folder: chosen });
            }}
          >
            Change…
          </button>
        </span>
        <span className="flai-setting-hint">
          A torrent with several files brings its own folder name, so it lands in one of its own
          inside this.
        </span>
      </label>

      <div className="flai-setting-pair">
        <Limit
          label="Download limit"
          value={config.downloadKbps}
          onChange={(downloadKbps) => void apply({ ...config, downloadKbps })}
        />
        <Limit
          label="Upload limit"
          value={config.uploadKbps}
          onChange={(uploadKbps) => void apply({ ...config, uploadKbps })}
        />
      </div>
      <p className="flai-setting-hint">
        Limits apply immediately. Leaving upload unlimited is the neighbourly setting — a swarm
        only works because people give back.
      </p>
    </section>
  );
}

function Limit({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <label className="flai-setting">
      <span className="flai-setting-label">
        {label} <span className="flai-setting-unit">KB/s · 0 is unlimited</span>
      </span>
      <input
        className="n-input"
        type="number"
        min={0}
        step={100}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        // Commit on blur, not per keystroke: typing "1500" would otherwise briefly set the
        // limit to 1 KB/s and stall every download mid-word.
        onBlur={() => onChange(Math.max(0, Math.floor(Number(draft) || 0)))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}
