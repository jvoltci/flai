import { useCallback, useState } from 'react';
import { bridge, formatBytes, type Hit } from './bridge';

/* Search asks your indexers, and flai ships knowing about none.
 *
 * Every result here comes from a Torznab endpoint the user added themselves — the same protocol
 * Prowlarr, Jackett, Sonarr and Radarr speak. That is not a limitation dressed up as a principle:
 * a client with a built-in list of sites is a client that goes stale in a month and gets pulled
 * from stores, and the people who actually run this already have Prowlarr.
 */
export function Search({ onAdded }: { onAdded: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());

  const run = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await bridge.search(trimmed));
    } catch (err) {
      setError(String(err));
      setHits(null);
    } finally {
      setBusy(false);
    }
  }, [query]);

  const add = useCallback(
    async (hit: Hit) => {
      try {
        await bridge.addResult(hit.url, '');
        setTaken((current) => new Set(current).add(hit.url));
        onAdded();
      } catch (err) {
        setError(String(err));
      }
    },
    [onAdded]
  );

  return (
    <section className="flai-panel flai-search">
      <form
        className="flai-command"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void run();
        }}
      >
        <input
          className="n-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your indexers"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" className="n-btn n-btn-fill" aria-busy={busy} disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <p className="n-note n-note-bad" role="alert">
          {error}
        </p>
      )}

      {hits !== null && hits.length === 0 && !error && (
        <p className="flai-hint">Nothing came back. Either no match, or an indexer is down.</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="flai-hits">
          {hits.map((hit) => (
            <li key={hit.url} className="flai-hit">
              <span className="flai-hit-title" title={hit.title}>
                {hit.title}
              </span>
              <span className="flai-hit-meta">
                {/* Seeders first: it is the one number that predicts whether this finishes. */}
                <b className="flai-seeders" data-dead={hit.seeders === 0 || undefined}>
                  {hit.seeders} seed
                </b>
                {hit.size > 0 && ` · ${formatBytes(hit.size)}`}
                {` · ${hit.indexer}`}
              </span>
              <button
                type="button"
                className="n-btn n-btn-sm n-btn-fill"
                disabled={taken.has(hit.url)}
                onClick={() => void add(hit)}
              >
                {taken.has(hit.url) ? 'Added' : 'Download'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
