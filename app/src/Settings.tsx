import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
 *
 * Every field carries an ⓘ. These are not obvious settings — "Torznab endpoint" means nothing
 * unless you already run Prowlarr — and a setting nobody understands is a setting nobody uses.
 * The help stays folded away so it costs nothing once you do know.
 */

const BLANK_INDEXER: Indexer = { name: '', url: '', apiKey: '' };
const BLANK_FEED: Feed = { name: '', url: '', label: '', contains: '', seen: [] };

/* A label, an ⓘ, and the control.
 *
 * The help answers the four questions somebody actually has, in the order they have them: what
 * is this, how do I use it, show me one, and what will bite me. The last one is not padding —
 * every setting here has a way of looking like it worked when it did not, and that is exactly
 * what a normal user cannot diagnose.
 */
function Field({
  label,
  what,
  how,
  example,
  watch,
  children,
}: {
  label: string;
  what: string;
  how: string;
  example: ReactNode;
  watch: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flai-setting">
      <div className="flai-setting-head">
        <span className="flai-setting-label">{label}</span>
        <button
          type="button"
          className="flai-help"
          aria-expanded={open}
          aria-label={`What does ${label} do?`}
          title="What is this?"
          onClick={() => setOpen(!open)}
        >
          i
        </button>
      </div>
      {open && (
        <div className="flai-help-text">
          <p>{what}</p>
          <p>
            <b>How to use it. </b>
            {how}
          </p>
          <p className="flai-help-eg">
            <b>Example. </b>
            {example}
          </p>
          <p className="flai-help-watch">
            <b>Watch out. </b>
            {watch}
          </p>
        </div>
      )}
      {children}
    </div>
  );
}

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

      <Field
        label="Download at once"
        what="How many downloads are allowed to run at the same time. Anything past the limit waits
          in a queue and starts on its own the moment a slot frees up, oldest first. You never have
          to come back and press anything."
        how="Pick a small number on a phone. Two or three suits most people. Everything is sharing
          one connection and one battery, so five at once all crawl and all finish late; the same
          five in a queue finish one after another and the first is watchable much sooner. Set 0 if
          you would rather run everything together and not think about it."
        example={
          <>
            Set <b>2</b>, then add five episodes. Two start downloading now. The other three say
            “waiting its turn”. When the first finishes, the third starts by itself.
          </>
        }
        watch={
          <>
            A download <i>you</i> paused is left alone. The queue never resumes it, and it never
            uses up a slot. Only downloads flai parked show “waiting its turn”.
          </>
        }
      >
        <input
          className="n-input"
          type="number"
          min={0}
          aria-label="Download at once"
          value={config.maxActive}
          onChange={(event) => edit({ maxActive: Math.max(0, Number(event.target.value) || 0) })}
        />
      </Field>

      <Field
        label="SOCKS5 proxy"
        what="Sends flai's connections through a server you already run, so the people you are
          swapping files with see that server's address instead of your own. Leave it empty and
          flai connects directly, which is what most people want."
        how="Type the address in the form socks5://host:port. If the proxy needs a login, put it in
          front as socks5://user:password@host:port. Then close flai completely and open it again.
          Clearing the box and restarting goes back to a direct connection."
        example={
          <>
            <code>socks5://127.0.0.1:1080</code> for a proxy running on this phone, or{' '}
            <code>socks5://me:secret@192.168.1.5:1080</code> for one on your home server that needs
            a login.
          </>
        }
        watch={
          <>
            <b>This is not a way to hide.</b> It covers connections to peers and to web trackers.
            Finding peers in the first place uses DHT, which sends plain UDP straight out and
            ignores the proxy entirely, and so do UDP trackers. Your real address is still visible
            to the swarm. Use a VPN for the whole phone if that is what you are after. Also: the
            setting does nothing until you fully close and reopen flai.
          </>
        }
      >
        <input
          className="n-input flai-setting-path"
          aria-label="SOCKS5 proxy"
          value={config.socksProxy}
          onChange={(event) => edit({ socksProxy: event.target.value })}
          placeholder="socks5://127.0.0.1:1080"
          spellCheck={false}
        />
      </Field>

      <Field
        label="Download only between certain hours"
        what="Downloads run inside the window you pick and pause outside it. Both the pausing and
          the starting again happen on their own, whether or not flai is open, so you can set it
          once and forget it."
        how="Tick the box, then pick a start time and an end time on your own clock. A window that
          runs past midnight is normal and works as you would expect. Untick the box to go back to
          downloading at any hour."
        example={
          <>
            <b>01:00</b> to <b>07:00</b> downloads while you are asleep and stops before you get
            up, so nothing is competing with you during the day.
          </>
        }
        watch={
          <>
            The hours are saved against the clock as it was when you set them. If you fly somewhere
            else, or the clocks go forward or back, open this and pick the times again or the
            window will be an hour out. Downloads paused by the window say “waiting its turn”, the
            same as queued ones.
          </>
        }
      >
        <label className="flai-check">
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
          Use a time window
        </label>
        {schedule && (
          <div className="flai-setting-row">
            <input
              className="n-input"
              type="time"
              aria-label="Start downloading at"
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
              aria-label="Stop downloading at"
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
      </Field>

      <Rows
        title="Indexers"
        what="Where the Search button looks. flai ships knowing about no sites at all, so Search
          does nothing until you add one here. It talks to your own search server, the same way
          Sonarr and Radarr do, using a standard called Torznab."
        how="Run Prowlarr or Jackett somewhere you control, usually a home server, a NAS or a PC.
          Open its web page, pick an indexer you have added there, and it will show you a Torznab
          URL and an API key. Copy those into the middle and last boxes. The name is only for you.
          Add as many as you like: Search asks all of them at the same time and merges the results,
          most seeders first, because seeders is what decides whether a download finishes."
        example={
          <>
            Name <b>Prowlarr</b>, URL{' '}
            <code>http://192.168.1.5:9696/api/v1/indexer/1/newznab</code>, and the API key from
            Prowlarr's own settings page.
          </>
        }
        watch={
          <>
            An indexer that does not reply within ten seconds is skipped without a word, so “no
            results” can quietly mean “my server is off”. If searches suddenly return nothing, open
            the URL in a browser and check the server is up. Also make sure the phone can reach it:
            a home address like 192.168.x.x only works while you are on that wifi.
          </>
        }
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
              aria-label="Indexer name"
            />
            <input
              className="n-input flai-setting-path"
              value={item.url}
              onChange={(event) => patch({ url: event.target.value })}
              placeholder="http://192.168.1.5:9696/api/v1/indexer/1/newznab"
              aria-label="Torznab URL"
              spellCheck={false}
            />
            <input
              className="n-input"
              value={item.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              placeholder="API key"
              aria-label="API key"
              spellCheck={false}
            />
          </>
        )}
      />

      <Rows
        title="Feeds"
        what="A feed flai watches for you. Every 15 minutes it checks, and anything new that
          matches your filter starts downloading by itself, tagged with your label. This is how you
          follow a show without ever going looking for it."
        how="Paste the feed's address into the URL box. In 'Title contains', put a word that has to
          appear in the name, which is how you keep quality or a season you want and drop the rest;
          leave it empty to take everything. 'Label' is a tag that shows on the download so you can
          see at a glance where it came from. The name is only for you."
        example={
          <>
            Paste a show's RSS feed, put <b>1080p</b> in <i>Title contains</i> and <b>From</b> in{' '}
            <i>Label</i>. Every new 1080p episode downloads on its own and shows a “From” tag in
            the list.
          </>
        }
        watch={
          <>
            An empty <i>Title contains</i> on a busy feed will take <b>everything</b> it publishes,
            which can be a lot of disk very quickly. Put a word in it first and widen it later.
            flai remembers the last 200 things it took from each feed so nothing arrives twice, but
            it cannot undownload something. Pair this with a queue limit above.
          </>
        }
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
              aria-label="Feed name"
            />
            <input
              className="n-input flai-setting-path"
              value={item.url}
              onChange={(event) => patch({ url: event.target.value })}
              placeholder="Feed URL"
              aria-label="Feed URL"
              spellCheck={false}
            />
            <input
              className="n-input"
              value={item.contains}
              onChange={(event) => patch({ contains: event.target.value })}
              placeholder="Title contains"
              aria-label="Title contains"
            />
            <input
              className="n-input"
              value={item.label}
              onChange={(event) => patch({ label: event.target.value })}
              placeholder="Label"
              aria-label="Label"
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
  what,
  how,
  example,
  watch,
  items,
  blank,
  onChange,
  render,
}: {
  title: string;
  what: string;
  how: string;
  example: ReactNode;
  watch: ReactNode;
  items: T[];
  blank: T;
  onChange: (next: T[]) => void;
  render: (item: T, patch: (fields: Partial<T>) => void) => ReactNode;
}) {
  return (
    <Field label={title} what={what} how={how} example={example} watch={watch}>
      <button
        type="button"
        className="n-btn n-btn-sm flai-add"
        onClick={() => onChange([...items, { ...blank }])}
      >
        Add {title.toLowerCase().replace(/s$/, '')}
      </button>

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
    </Field>
  );
}
