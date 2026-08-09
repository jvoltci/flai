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
};

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
