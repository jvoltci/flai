/* IndexedDB, hand-rolled. It holds two things: the download queue, and the directory handle
 * you picked for saved files.
 *
 * IndexedDB rather than localStorage because a FileSystemDirectoryHandle is not a string —
 * it is structured-cloneable, and IndexedDB is the only web storage that can hold one. That
 * handle is what makes this set-and-forget: pick the folder once and every later download
 * lands there with no picker.
 *
 * No wrapper library: this is ~60 lines against idb's 2 KB, and it is the only storage the
 * app has. */

const DB_NAME = 'flai';
const DB_VERSION = 1;
const JOBS = 'jobs';
const SETTINGS = 'settings';

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error';

export interface Job {
  /** `${infoHash}:${fileIndex}` — one file of one torrent is one download. */
  id: string;
  infoHash: string;
  fileIndex: number;
  /** Kept so the client can silently re-POST /metadata when the server forgets the torrent. */
  magnet: string;
  torrentName: string;
  name: string;
  size: number;
  contentType: string;
  bytesDone: number;
  status: JobStatus;
  error?: string;
  handle?: FileSystemFileHandle;
  addedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`indexedDB ${mode} failed`));
      })
  );
}

export const jobs = {
  all: () => run<Job[]>(JOBS, 'readonly', (s) => s.getAll() as IDBRequest<Job[]>),
  put: (job: Job) => run<IDBValidKey>(JOBS, 'readwrite', (s) => s.put(job)),
  remove: (id: string) => run<undefined>(JOBS, 'readwrite', (s) => s.delete(id)),
};

export const settings = {
  get: <T>(key: string) => run<T | undefined>(SETTINGS, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key: string, value: unknown) => run<IDBValidKey>(SETTINGS, 'readwrite', (s) => s.put(value, key)),
  remove: (key: string) => run<undefined>(SETTINGS, 'readwrite', (s) => s.delete(key)),
};
