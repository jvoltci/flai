import type { FileEntry, Metadata } from './api';

/* The page's half of the downloader. All it does is register the worker, hand it a job, and
 * click a link. Everything that can go wrong during the transfer is handled in public/sw.js. */

const BASE = import.meta.env.BASE_URL;

export type DownloadState = 'starting' | 'running' | 'waking' | 'done' | 'error' | 'cancelled';

export interface DownloadStatus {
  id: string;
  name: string;
  size: number;
  bytes: number;
  state: DownloadState;
  error?: string;
}

interface ProgressMessage {
  type: 'flai-progress';
  id: string;
  state: DownloadState;
  bytes?: number;
  error?: string;
}

let registration: Promise<void> | null = null;

export function serviceWorkerSupported(): boolean {
  return 'serviceWorker' in navigator;
}

/* Registering is not enough — a worker that is registered but not yet *controlling* this page
 * will not see the download request, and the link 404s. skipWaiting/clients.claim in the
 * worker make that window small, but on the very first load it still exists, so wait for the
 * controller to actually arrive. */
export function ensureWorker(): Promise<void> {
  registration ??= (async () => {
    await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  })();
  return registration;
}

export function onProgress(fn: (message: ProgressMessage) => void): () => void {
  const handler = (event: MessageEvent) => {
    if ((event.data as ProgressMessage)?.type === 'flai-progress') fn(event.data as ProgressMessage);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

export async function startDownload(args: {
  apiBaseUrl: string;
  token: string;
  magnet: string;
  meta: Metadata;
  file: FileEntry;
}): Promise<DownloadStatus> {
  await ensureWorker();
  const worker = navigator.serviceWorker.controller;
  if (!worker) throw new Error('the download worker did not start — reload the page');

  const id = `${args.meta.infoHash}:${args.file.index}:${performance.now().toFixed(0)}`;
  const job = {
    id,
    baseUrl: args.apiBaseUrl,
    token: args.token,
    magnet: args.magnet,
    infoHash: args.meta.infoHash,
    fileIndex: args.file.index,
    name: args.file.name,
    size: args.file.length,
    contentType: args.file.contentType,
  };

  // Wait for the worker to confirm it holds the job before requesting the URL, otherwise the
  // fetch can arrive first and find nothing.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the download worker did not answer')), 5000);
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'flai-accepted' && event.data.id === id) {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    worker.postMessage({ type: 'flai-download', job });
  });

  /* The response carries Content-Disposition: attachment, so the browser downloads it and the
   * page does not navigate. No picker, no permission, straight to your Downloads folder. */
  const link = document.createElement('a');
  link.href = `${BASE}__flai-dl?id=${encodeURIComponent(id)}`;
  link.download = args.file.name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();

  return { id, name: args.file.name, size: args.file.length, bytes: 0, state: 'starting' };
}
