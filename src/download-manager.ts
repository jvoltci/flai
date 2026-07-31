import { ApiClient, ApiError, type FileEntry, type Metadata } from './api';
import { jobs as jobStore, settings, type Job } from './idb';

/* The actual downloader. flai-api is a byte pump; this is the thing that turns a stream of
 * 8 MB slices into a 4 GB file on your disk, and keeps doing it across server restarts,
 * cold starts and dropped Wi-Fi.
 *
 * ── why the loop has no timers ─────────────────────────────────────────────────
 *
 * Chrome clamps setTimeout in a hidden tab to once a minute after five minutes. A loop
 * scheduled on timers would therefore crawl the moment you switch tabs — which is exactly
 * when a long download is running. So the loop is a chain of awaited fetches, which the
 * throttler does not touch. The only timer is the retry backoff, where a hidden tab waiting
 * up to a minute before retrying is harmless.
 *
 * ── why bytes go straight to disk ──────────────────────────────────────────────
 *
 * The response body is piped into a FileSystemWritableFileStream chunk by chunk, so peak
 * memory is a few hundred KB regardless of file size, and there is no second copy in browser
 * storage to run into a quota.
 *
 * The one cost: a writable commits on close(), not on write(). So the writable is closed on
 * pause, on completion and on pagehide, and a hard browser crash loses the bytes written
 * since the last commit. Resume then restarts from the file's real size on disk, never from
 * zero. Committing more often is not free — reopening with keepExistingData copies the file
 * so far, which for a 4 GB download would cost tens of GB of disk churn.
 */

const ASK_BYTES = 8 * 1024 * 1024;
const MAX_BACKOFF_MS = 30_000;
const FOLDER_KEY = 'saveFolder';
const EMIT_EVERY_BYTES = 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensurePermission(handle: FileSystemHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' } as const;
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export class DownloadManager {
  #jobs = new Map<string, Job>();
  #listeners = new Set<() => void>();
  #abort: AbortController | null = null;
  #writable: FileSystemWritableFileStream | null = null;
  #pumping = false;
  #speed = new Map<string, number>();
  #folder: FileSystemDirectoryHandle | null = null;

  constructor(private readonly api: ApiClient) {
    // Best effort: the browser will not wait for an async close, but on a normal tab close
    // it usually lands, and it is the difference between committing this session's bytes
    // and discarding them.
    addEventListener('pagehide', () => void this.#writable?.close().catch(() => {}));
  }

  async hydrate(): Promise<void> {
    this.#folder = (await settings.get<FileSystemDirectoryHandle>(FOLDER_KEY)) ?? null;
    for (const job of await jobStore.all()) {
      /* The file on disk is the authority, not the counter. A crash can leave the counter
       * ahead of what was actually committed, and trusting it would write the next chunk at
       * the wrong offset and silently corrupt the file. */
      if (job.handle) {
        try {
          const onDisk = (await job.handle.getFile()).size;
          job.bytesDone = Math.min(job.bytesDone, onDisk);
        } catch {
          job.bytesDone = 0; // file moved or deleted underneath us
        }
      }
      // A page load means the previous session ended, whatever the record says.
      if (job.status === 'running') job.status = 'paused';
      this.#jobs.set(job.id, job);
    }
    this.#emit();
    /* Deliberately does not auto-start. Writing to a handle from a previous browser session
     * needs requestPermission(), and that only works inside a user gesture — so an automatic
     * resume here would fail on exactly the case it exists for. The Downloads tab offers one
     * "Resume all" button instead, which is one click and always works. */
  }

  /** Restarts everything unfinished. Must be called from a click, for the permission prompt. */
  resumeAll(): void {
    for (const job of this.#jobs.values()) {
      if (job.status === 'paused' || job.status === 'error') this.resume(job.id);
    }
  }

  get unfinished(): number {
    return [...this.#jobs.values()].filter((j) => j.status !== 'done').length;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  speedOf(id: string): number {
    return this.#speed.get(id) ?? 0;
  }

  get folderName(): string | null {
    return this.#folder?.name ?? null;
  }

  /** Pick the save folder once; every later download lands there with no prompt. */
  async chooseFolder(): Promise<void> {
    if (!window.showDirectoryPicker) throw new Error('this browser has no directory picker');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
    this.#folder = dir;
    await settings.set(FOLDER_KEY, dir);
    this.#emit();
  }

  async enqueue(magnet: string, meta: Metadata, file: FileEntry): Promise<void> {
    const id = `${meta.infoHash}:${file.index}`;
    if (this.#jobs.has(id)) return;

    const handle = await this.#handleFor(file);
    const job: Job = {
      id,
      infoHash: meta.infoHash,
      fileIndex: file.index,
      magnet,
      torrentName: meta.name,
      name: file.name,
      size: file.length,
      contentType: file.contentType,
      bytesDone: Math.min((await handle.getFile()).size, file.length),
      status: 'queued',
      handle,
      addedAt: Date.now(),
    };
    await this.#save(job);
    void this.#pump();
  }

  async #handleFor(file: FileEntry): Promise<FileSystemFileHandle> {
    if (this.#folder) return this.#folder.getFileHandle(this.#uniqueName(file.name), { create: true });
    if (!window.showSaveFilePicker) throw new Error('this browser cannot save files directly');
    return window.showSaveFilePicker({ suggestedName: file.name, startIn: 'downloads' });
  }

  /** Two torrents can contain the same filename; without this the second would resume into
   *  the first one's bytes. */
  #uniqueName(name: string): string {
    const taken = new Set([...this.#jobs.values()].map((j) => j.handle?.name ?? j.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  resume(id: string): void {
    const job = this.#jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'done') return;
    job.status = 'queued';
    job.error = undefined;
    void this.#save(job);
    void this.#pump();
  }

  pause(id: string): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    if (job.status === 'running') this.#abort?.abort();
    else if (job.status === 'queued') {
      job.status = 'paused';
      void this.#save(job);
    }
  }

  async remove(id: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (job?.status === 'running') this.#abort?.abort();
    this.#jobs.delete(id);
    this.#speed.delete(id);
    await jobStore.remove(id);
    this.#emit();
  }

  /* One at a time, deliberately. flai-api allows a single reader per torrent — two readers at
   * different offsets would evict each other's pieces from the sliding window and both would
   * crawl — and a 512 MB box holds two torrents at most. A serial queue is the honest shape,
   * and it is why the Downloads tab shows a queue rather than a pile of stalled bars. */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const next = this.list().reverse().find((j) => j.status === 'queued');
        if (!next) break;
        await this.#run(next);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #run(job: Job): Promise<void> {
    if (!job.handle) {
      job.status = 'error';
      job.error = 'no save location — remove and add again';
      await this.#save(job);
      return;
    }
    if (!(await ensurePermission(job.handle))) {
      job.status = 'paused';
      job.error = 'needs permission to write the file — press Resume';
      await this.#save(job);
      return;
    }

    job.status = 'running';
    job.error = undefined;
    await this.#save(job);

    this.#abort = new AbortController();
    const signal = this.#abort.signal;

    let pos = Math.min(job.bytesDone, (await job.handle.getFile()).size);
    const writable = await job.handle.createWritable({ keepExistingData: true });
    this.#writable = writable;

    let backoff = 500;
    let windowBytes = 0;
    let windowStart = Date.now();
    let sinceEmit = 0;

    try {
      while (pos < job.size && !signal.aborted) {
        const end = Math.min(job.size - 1, pos + ASK_BYTES - 1);
        let res: Response;
        try {
          res = await this.api.chunk(job.infoHash, job.fileIndex, pos, end, signal);
        } catch (err) {
          if (signal.aborted) break;
          const fatal = await this.#recover(err, job, signal, backoff);
          if (fatal) {
            job.error = fatal;
            job.status = 'error';
            await this.#save(job);
            return;
          }
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
        backoff = 500;

        try {
          const reader = res.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            await writable.write({ type: 'write', position: pos, data: value });
            pos += value.byteLength;
            windowBytes += value.byteLength;
            sinceEmit += value.byteLength;

            const elapsed = Date.now() - windowStart;
            if (elapsed > 1000) {
              this.#speed.set(job.id, (windowBytes / elapsed) * 1000);
              windowBytes = 0;
              windowStart = Date.now();
            }
            if (sinceEmit >= EMIT_EVERY_BYTES) {
              sinceEmit = 0;
              job.bytesDone = pos;
              this.#emit();
            }
          }
        } catch {
          // A drop mid-chunk keeps whatever was written; the next pass resumes from `pos`.
          if (signal.aborted) break;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }

        job.bytesDone = pos;
        await this.#save(job);
      }

      job.bytesDone = pos;
      job.status = pos >= job.size ? 'done' : 'paused';
    } finally {
      this.#speed.delete(job.id);
      this.#writable = null;
      this.#abort = null;
      // Commits the swap file to the real file. Must happen before the size is trusted again.
      await writable.close().catch(() => {});
      await this.#save(job);
    }
  }

  /**
   * @returns a message when the failure is fatal for this job, or null when the caller should
   *          back off and retry. This is where "set and forget" actually lives.
   */
  async #recover(err: unknown, job: Job, signal: AbortSignal, backoff: number): Promise<string | null> {
    if (err instanceof ApiError) {
      /* The stateless contract: the server dropped the torrent (spun down, restarted, or
       * evicted it for capacity) and cannot get it back on its own, because it never stored
       * the magnet. We did. Re-post it and carry on — no user-visible failure. */
      if (err.code === 'not_active') {
        try {
          await this.api.metadata(job.magnet, signal);
          return null;
        } catch {
          await sleep(backoff);
          return null;
        }
      }
      // Another reader holds the torrent's single window. Wait for it.
      if (err.code === 'busy') {
        await sleep(2000);
        return null;
      }
      if (err.status === 401) return 'session expired — sign in again, then press Resume';
      if (err.code === 'not_found') return 'that file is no longer in the torrent';
      if (err.code === 'bad_request' || err.code === 'range_required') return err.message;
      // 429 and 5xx are transient by definition.
      await sleep(backoff);
      return null;
    }
    // TypeError from fetch: offline, DNS, or the box is cold-starting. Always retryable.
    await sleep(backoff);
    return null;
  }

  async #save(job: Job): Promise<void> {
    this.#jobs.set(job.id, job);
    await jobStore.put(job);
    this.#emit();
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
}
