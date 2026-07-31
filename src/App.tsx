import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, type FileEntry, type Metadata } from './api';
import { DownloadManager } from './download-manager';
import type { Job } from './idb';
import { Tabs, TabPanel, type TabDef } from './components/Tabs';
import { SignIn } from './components/SignIn';
import { Browse } from './components/Browse';
import { Downloads } from './components/Downloads';
import { Player } from './components/Player';
import { Settings } from './components/Settings';

const DEFAULT_API = 'https://flai-api.onrender.com';
const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? DEFAULT_API;

type TabId = 'downloads' | 'browse' | 'settings';
type Health = 'checking' | 'online' | 'offline';

/** The manager's job list lives outside React, so mirror it into state on every change. */
function useJobs(manager: DownloadManager): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    const update = () => setJobs(manager.list());
    update();
    return manager.subscribe(update);
  }, [manager]);
  return jobs;
}

/** Speed and ETA are derived, not stored. One tick a second is enough to keep them honest. */
function useTicker(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return tick;
}

export function App() {
  const api = useMemo(() => new ApiClient(apiBaseUrl), []);
  const manager = useMemo(() => new DownloadManager(api), [api]);

  const [signedIn, setSignedIn] = useState(api.signedIn);
  const [tab, setTab] = useState<TabId>('browse');
  const [player, setPlayer] = useState<{ meta: Metadata; file: FileEntry } | null>(null);
  const [health, setHealth] = useState<Health>('checking');

  const jobs = useJobs(manager);
  const running = jobs.some((j) => j.status === 'running');
  const tick = useTicker(running);

  useEffect(() => {
    void manager.hydrate();
  }, [manager]);

  /* The free tier sleeps after 15 idle minutes and takes about a minute to wake, and there is
   * no keep-warm ping any more — it cost 730 of the 750 free hours a month. So the first visit
   * of the day may find the box cold. Saying so beats a spinner that looks broken. */
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const ping = async () => {
      const ok = await api.health();
      if (!live) return;
      setHealth(ok ? 'online' : 'offline');
      if (!ok) timer = setTimeout(ping, 5000);
    };
    void ping();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api]);

  const onPlay = useCallback((meta: Metadata, file: FileEntry) => {
    setPlayer({ meta, file });
  }, []);

  const tabs: TabDef[] = [
    { id: 'downloads', label: 'Downloads', badge: jobs.filter((j) => j.status !== 'done').length },
    { id: 'browse', label: 'Browse' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <main id="home" className="n-container flai-shell n-stack">
      <header className="n-stack flai-hero">
        <div className="n-cluster flai-brand">
          <div className="n-stack flai-tight">
            <p className="flai-eyebrow">magnet · resume · straight to disk</p>
            {/* The page's one --text-display element. */}
            <h1 className="flai-word">
              fl<b>ai</b>
            </h1>
          </div>
          <span
            className={
              health === 'online'
                ? 'n-badge n-badge-ok'
                : health === 'offline'
                  ? 'n-badge n-badge-warn'
                  : 'n-badge'
            }
            role="status"
          >
            <i className="n-badge-glyph" aria-hidden="true">
              {health === 'online' ? '✓' : health === 'offline' ? '!' : '·'}
            </i>
            {health === 'online' ? 'bridge up' : health === 'offline' ? 'waking the bridge…' : 'checking…'}
          </span>
        </div>
      </header>

      {!signedIn ? (
        <SignIn api={api} onSignedIn={() => setSignedIn(true)} />
      ) : (
        <>
          <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />

          <TabPanel id="downloads" active={tab}>
            <Downloads manager={manager} jobs={jobs} tick={tick} />
          </TabPanel>

          <TabPanel id="browse" active={tab}>
            {player && (
              <Player
                api={api}
                meta={player.meta}
                file={player.file}
                onClose={() => setPlayer(null)}
              />
            )}
            <Browse
              api={api}
              manager={manager}
              onPlay={onPlay}
              onQueued={() => setTab('downloads')}
            />
          </TabPanel>

          <TabPanel id="settings" active={tab}>
            <Settings
              api={api}
              manager={manager}
              onSignedOut={() => {
                setSignedIn(false);
                setPlayer(null);
              }}
            />
          </TabPanel>
        </>
      )}
    </main>
  );
}
