import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  hhMmToMinute,
  localToUtcMinute,
  minuteToHhMm,
  utcToLocalMinute,
  type Feed,
  type Indexer,
  type Settings as Config,
} from './bridge';

/* Only what nobody can guess for you.
 *
 * The Settings screen this replaces asked where downloads go and how fast they may run, and got
 * deleted for it — there is one right answer to the first and the second only makes things worse.
 * Everything here is a fact the app cannot know: your proxy, your indexer, your feed, your hours.
 */

const BLANK_INDEXER: Indexer = { name: '', url: '', apiKey: '' };
const BLANK_FEED: Feed = { name: '', url: '', label: '', contains: '', seen: [] };

export function Settings({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState<'no' | 'yes' | 'restart'>('no');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge
      .getSettings()
      .then(setConfig)
      .catch((err) => setError(String(err)));
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    setError(null);
    try {
      const proxyChanged = await bridge.setSettings(config);
      setSaved(proxyChanged ? 'restart' : 'yes');
    } catch (err) {
      setError(String(err));
    }
  }, [config]);

  if (!config) {
    return (
      <section className="flai-panel">
        <p className="flai-hint">{error ?? 'Loading…'}</p>
      </section>
    );
  }

  const edit = (patch: Partial<Config>) => {
    setConfig({ ...config, ...patch });
    setSaved('no');
  };

  const schedule = config.schedule;

  return (
    <section className="flai-panel flai-settings">
      <div className="flai-panel-head">
        <h2 className="flai-panel-title">Settings</h2>
        <div className="n-cluster">
          {saved === 'yes' && <span className="flai-saved-flash">Saved</span>}
          {saved === 'restart' && (
            <span className="flai-saved-flash flai-warn">Saved — restart for the proxy</span>
          )}
          <button type="button" className="n-btn n-btn-fill n-btn-sm" onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="n-btn n-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {error && (
        <p className="n-note n-note-bad" role="alert">
          {error}
        </p>
      )}

      {/* ── how much runs at once ─────────────────────────────────────────── */}
      <div className="flai-setting-pair">
        <label className="flai-setting">
          <span className="flai-setting-label">Download at once</span>
          <input
            className="n-input"
            type="number"
            min={0}
            value={config.maxActive}
            onChange={(event) => edit({ maxActive: Math.max(0, Number(event.target.value) || 0) })}
          />
          <span className="flai-setting-hint">0 means no queue — everything runs together.</span>
        </label>

        <label className="flai-setting">
          <span className="flai-setting-label">SOCKS5 proxy</span>
          <input
            className="n-input flai-setting-path"
            value={config.socksProxy}
            onChange={(event) => edit({ socksProxy: event.target.value })}
            placeholder="socks5://127.0.0.1:1080"
            spellCheck={false}
          />
          <span className="flai-setting-hint">Applies on restart. Empty connects directly.</span>
        </label>
      </div>

      {/* ── when it may run ───────────────────────────────────────────────── */}
      <div className="flai-setting">
        <label className="flai-setting-label flai-check">
          <input
            type="checkbox"
            checked={schedule !== null}
            onChange={(event) =>
              edit({
                schedule: event.target.checked
                  ? { fromMinuteUtc: localToUtcMinute(60), toMinuteUtc: localToUtcMinute(7 * 60) }
                  : null,
              })
            }
          />
          Only download between certain hours
        </label>
        {schedule && (
          <div className="flai-setting-row">
            <input
              className="n-input"
              type="time"
              value={minuteToHhMm(utcToLocalMinute(schedule.fromMinuteUtc))}
              onChange={(event) =>
                edit({
                  schedule: {
                    ...schedule,
                    fromMinuteUtc: localToUtcMinute(hhMmToMinute(event.target.value)),
                  },
                })
              }
            />
            <input
              className="n-input"
              type="time"
              value={minuteToHhMm(utcToLocalMinute(schedule.toMinuteUtc))}
              onChange={(event) =>
                edit({
                  schedule: {
                    ...schedule,
                    toMinuteUtc: localToUtcMinute(hhMmToMinute(event.target.value)),
                  },
                })
              }
            />
          </div>
        )}
      </div>

      {/* ── indexers ──────────────────────────────────────────────────────── */}
      <Rows
        title="Indexers"
        hint="Torznab endpoints — the URL and key Prowlarr or Jackett shows you."
        items={config.indexers}
        blank={BLANK_INDEXER}
        onChange={(indexers) => edit({ indexers })}
        render={(item, patch) => (
          <>
            <input
              className="n-input"
              value={item.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Name"
            />
            <input
              className="n-input flai-setting-path"
              value={item.url}
              onChange={(event) => patch({ url: event.target.value })}
              placeholder="http://host:9696/api/v1/indexer/1/newznab"
              spellCheck={false}
            />
            <input
              className="n-input"
              value={item.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              placeholder="API key"
              spellCheck={false}
            />
          </>
        )}
      />

      {/* ── feeds ─────────────────────────────────────────────────────────── */}
      <Rows
        title="Feeds"
        hint="Checked every 15 minutes. Anything new that matches is downloaded."
        items={config.feeds}
        blank={BLANK_FEED}
        onChange={(feeds) => edit({ feeds })}
        render={(item, patch) => (
          <>
            <input
              className="n-input"
              value={item.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Name"
            />
            <input
              className="n-input flai-setting-path"
              value={item.url}
              onChange={(event) => patch({ url: event.target.value })}
              placeholder="Feed URL"
              spellCheck={false}
            />
            <input
              className="n-input"
              value={item.contains}
              onChange={(event) => patch({ contains: event.target.value })}
              placeholder="Title contains"
            />
            <input
              className="n-input"
              value={item.label}
              onChange={(event) => patch({ label: event.target.value })}
              placeholder="Label"
            />
          </>
        )}
      />
    </section>
  );
}

/* One editor for both lists, because an indexer and a feed are the same shape of thing: a row of
 * fields, an add and a remove. Two near-identical components would drift apart within a week. */
function Rows<T>({
  title,
  hint,
  items,
  blank,
  onChange,
  render,
}: {
  title: string;
  hint: string;
  items: T[];
  blank: T;
  onChange: (next: T[]) => void;
  render: (item: T, patch: (fields: Partial<T>) => void) => React.ReactNode;
}) {
  return (
    <div className="flai-setting">
      <div className="flai-panel-head">
        <div>
          <span className="flai-setting-label">{title}</span>
          <p className="flai-setting-hint">{hint}</p>
        </div>
        <button
          type="button"
          className="n-btn n-btn-sm"
          onClick={() => onChange([...items, { ...blank }])}
        >
          Add
        </button>
      </div>

      {items.map((item, index) => (
        <div className="flai-setting-row" key={index}>
          {render(item, (fields) =>
            onChange(items.map((old, i) => (i === index ? { ...old, ...fields } : old)))
          )}
          <button
            type="button"
            className="n-btn n-btn-sm"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
