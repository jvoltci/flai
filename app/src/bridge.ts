import { invoke } from '@tauri-apps/api/core';

export interface FileEntry {
  index: number;
  name: string;
  length: number;
}

export interface TorrentInfo {
  infoHash: string;
  name: string;
  total: number;
  files: FileEntry[];
}

export interface FileProgress {
  index: number;
  name: string;
  length: number;
  done: number;
  selected: boolean;
  first: boolean;
}

export interface Peers {
  live: number;
  connecting: number;
  queued: number;
  seen: number;
  dead: number;
}

export interface TorrentRow {
  id: number;
  infoHash: string;
  name: string;
  state: 'initializing' | 'live' | 'paused' | 'error';
  error: string | null;
  finished: boolean;
  progressBytes: number;
  totalBytes: number;
  uploadedBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: Peers;
  etaSeconds: number | null;
  outputFolder: string;
  priorityCount: number;
  fileCount: number;
  label: string;
  /** Stopped by the queue or the schedule, not by the user. */
  queued: boolean;
}

export interface Hit {
  title: string;
  url: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
}

export interface Indexer {
  name: string;
  url: string;
  apiKey: string;
}

export interface Feed {
  name: string;
  url: string;
  label: string;
  contains: string;
  seen: string[];
}

/** Minutes past UTC midnight. The UI converts, so Rust never needs a timezone. See settings.rs. */
export interface Schedule {
  fromMinuteUtc: number;
  toMinuteUtc: number;
}

export interface Settings {
  socksProxy: string;
  indexers: Indexer[];
  feeds: Feed[];
  maxActive: number;
  schedule: Schedule | null;
  labels: Record<string, string>;
}

/* The whole backend. No HTTP, no token — the torrent engine is in this process, so there is
 * nothing to authenticate to and nothing to keep warm. */
export const bridge = {
  inspect: (magnet: string) => invoke<TorrentInfo>('inspect', { magnet }),
  start: (magnet: string, files: number[], folder: string | null) =>
    invoke<number>('start', { magnet, files, folder }),
  torrents: () => invoke<TorrentRow[]>('torrents'),
  files: (id: number) => invoke<FileProgress[]>('files', { id }),
  prioritise: (id: number, files: number[]) => invoke<void>('prioritise', { id, files }),
  takeEverything: (id: number) => invoke<void>('take_everything', { id }),
  pause: (id: number) => invoke<void>('pause', { id }),
  resume: (id: number) => invoke<void>('resume', { id }),
  forget: (id: number, deleteFiles: boolean) => invoke<void>('forget', { id, deleteFiles }),
  /* Android only. Desktops use the opener plugin from the UI, which already knows how to
   * reveal a folder in Finder or Explorer. */
  openDownload: (path: string) => invoke<void>('open_download', { path }),
  defaultFolder: () => invoke<string>('default_folder'),

  /** A localhost URL a player can open now, mid-download. See stream_url in lib.rs. */
  play: (id: number, file: number) => invoke<void>('play', { id, file }),
  getSettings: () => invoke<Settings>('get_settings'),
  /** Resolves true when the proxy changed, which only takes effect after a restart. */
  setSettings: (incoming: Settings) => invoke<boolean>('set_settings', { incoming }),
  search: (query: string) => invoke<Hit[]>('search', { query }),
  addResult: (url: string, label: string) => invoke<number>('add_result', { url, label }),
  setLabel: (infoHash: string, label: string) =>
    invoke<void>('set_label', { infoHash, label }),
};

/* Day or night, and day unless told otherwise.
 *
 * nilam does the whole job through `color-scheme` and `light-dark()`, so switching themes is one
 * class on <html> and every token follows — there is no second palette to keep in step. Leaving
 * the class off would follow the OS, which is the usual default and the wrong one here: the ask
 * was for day by default, and a phone in dark mode would otherwise never show it.
 */
export type Theme = 'light' | 'dark';

const THEME_KEY = 'flai.theme';

export function readTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.toggle('light', theme === 'light');
  localStorage.setItem(THEME_KEY, theme);
}

/** Local wall-clock minutes -> minutes past UTC midnight, and back. */
export function localToUtcMinute(minute: number): number {
  const offset = new Date().getTimezoneOffset();
  return (((minute + offset) % 1440) + 1440) % 1440;
}

export function utcToLocalMinute(minute: number): number {
  const offset = new Date().getTimezoneOffset();
  return (((minute - offset) % 1440) + 1440) % 1440;
}

export function minuteToHhMm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hhMmToMinute(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return ((h * 60 + m) % 1440 + 1440) % 1440;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return hours > 48
    ? `${Math.round(hours / 24)}d`
    : `${hours}h ${Math.round((seconds % 3600) / 60)}m`;
}
