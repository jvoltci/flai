import { useCallback, useEffect, useState } from 'react';
import type { Metadata } from './api';

/* The saved list.
 *
 * A magnet is the only thing needed to get a torrent back, and it is a short string — so this
 * is localStorage, not IndexedDB. IndexedDB earns its keep when there is something in the data
 * that cannot be a string; here there is not, and a synchronous read means the list is on
 * screen in the first paint rather than a frame later.
 *
 * The name and size are cached alongside the magnet purely so the list can be shown without
 * asking the bridge about every entry. Reopening always re-fetches; these are a label, not a
 * source of truth, and a torrent whose swarm has died will say so when you open it rather than
 * being quietly dropped from the list.
 */

const KEY = 'flai.wishlist';

export interface SavedTorrent {
  infoHash: string;
  name: string;
  size: number;
  files: number;
  magnet: string;
  savedAt: number;
}

function read(): SavedTorrent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // Anything without a magnet cannot be reopened, so it is not worth keeping.
    return raw.filter(
      (e): e is SavedTorrent =>
        typeof e === 'object' && e !== null && typeof (e as SavedTorrent).magnet === 'string'
    );
  } catch {
    return [];
  }
}

function write(list: SavedTorrent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* Quota or a private window with storage off. Losing the list is not worth an error
     * dialogue over — the download you are doing right now still works. */
  }
}

/* One event so two mounted components — the list and the star — cannot disagree. `storage`
 * only fires in *other* tabs, so same-tab updates need their own. */
const CHANGED = 'flai:wishlist';

export function useWishlist() {
  const [items, setItems] = useState<SavedTorrent[]>(read);

  useEffect(() => {
    const sync = () => setItems(read());
    addEventListener(CHANGED, sync);
    addEventListener('storage', sync);
    return () => {
      removeEventListener(CHANGED, sync);
      removeEventListener('storage', sync);
    };
  }, []);

  const publish = useCallback((next: SavedTorrent[]) => {
    write(next);
    dispatchEvent(new Event(CHANGED));
  }, []);

  const toggle = useCallback(
    (meta: Metadata, magnet: string) => {
      const list = read();
      const without = list.filter((e) => e.infoHash !== meta.infoHash);
      // Newest first, so the list reads as a stack of "things I meant to get".
      publish(
        without.length === list.length
          ? [
              {
                infoHash: meta.infoHash,
                name: meta.name,
                size: meta.size,
                files: meta.files.length,
                magnet,
                savedAt: Date.now(),
              },
              ...list,
            ]
          : without
      );
    },
    [publish]
  );

  const remove = useCallback(
    (infoHash: string) => publish(read().filter((e) => e.infoHash !== infoHash)),
    [publish]
  );

  const has = useCallback(
    (infoHash: string) => items.some((e) => e.infoHash === infoHash),
    [items]
  );

  return { items, toggle, remove, has };
}

export function savedAgo(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
