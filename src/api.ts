export interface FileEntry {
  index: number;
  name: string;
  path: string;
  length: number;
  contentType: string;
  streamable: boolean;
}

export interface Metadata {
  infoHash: string;
  name: string;
  size: number;
  pieceLength: number;
  files: FileEntry[];
}

export interface TorrentStats {
  active: boolean;
  ready?: boolean;
  numPeers?: number;
  downloadSpeed?: number;
  streams?: number;
}

/** Carries the server's error code, which the download loop branches on. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'flai.token';
const EXP_KEY = 'flai.token.expiresAt';

/* localStorage, so closing the tab does not end the session — the token outlives the browser
 * and you sign in once a day rather than once a visit.
 *
 * This was sessionStorage, on the reasoning that a bearer credential should be scoped to the
 * tab. The reasoning still holds; the balance does not. This is a two-person tool behind one
 * password, on machines those two people own, and the expiry does the real work: the token is
 * an HMAC over its own expiry keyed by PASS, so it is useless after 12 hours and changing PASS
 * invalidates every one ever issued. The password itself is still never stored anywhere. */
export class ApiClient {
  #token: string | null = null;

  constructor(readonly baseUrl: string) {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiresAt = Number(localStorage.getItem(EXP_KEY) ?? 0);
    if (token && expiresAt > Date.now()) this.#token = token;
    else this.signOut();
  }

  get signedIn(): boolean {
    return this.#token !== null;
  }

  signOut(): void {
    this.#token = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXP_KEY);
  }

  async signIn(password: string): Promise<void> {
    const body = await this.#json<{ token: string; expiresAt: number }>('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    this.#token = body.token;
    localStorage.setItem(TOKEN_KEY, body.token);
    localStorage.setItem(EXP_KEY, String(body.expiresAt));
  }

  async metadata(magnet: string, signal?: AbortSignal): Promise<Metadata> {
    return this.#json<Metadata>('/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.#auth() },
      body: JSON.stringify({ url: magnet }),
      signal,
    });
  }

  /* Token in the query string, because a <video src>, an <a download> and an EventSource all
   * cannot set headers. That is why tokens expire: a URL leaks in a way a header does not. */
  streamUrl(infoHash: string, fileIndex: number): string {
    const url = new URL(`${this.baseUrl}/torrent/${infoHash}/${fileIndex}`);
    if (this.#token) url.searchParams.set('t', this.#token);
    return url.toString();
  }

  /* The download link carries its own magnet, which is what lets it heal itself. The bridge
   * stores nothing, so after a spin-down or a redeploy it has no way to find this torrent
   * again — but the URL Chrome is retrying has everything needed to re-add it. That is how a
   * native download survives a server restart with no JavaScript involved at all. */
  downloadUrl(infoHash: string, fileIndex: number, magnet: string): string {
    const url = new URL(this.streamUrl(infoHash, fileIndex));
    url.searchParams.set('dl', '1');
    url.searchParams.set('m', magnet);
    return url.toString();
  }

  /* Asks whether a download would be served, before handing the URL to the browser.
   *
   * Once the download manager has a URL the page gets no say in it — a 409 is not an error the
   * user sees, it is a 120-byte JSON file saved under the name of the episode they wanted. One
   * round trip, and it reads no bytes from the swarm. */
  async probe(infoHash: string, fileIndex: number, magnet: string): Promise<void> {
    const url = new URL(this.downloadUrl(infoHash, fileIndex, magnet));
    url.searchParams.set('probe', '1');
    const res = await fetch(url, { headers: this.#auth() });
    if (!res.ok) throw await this.#error(res);
  }

  watch(infoHash: string, onTick: (stats: TorrentStats) => void): () => void {
    const url = new URL(`${this.baseUrl}/stats/${infoHash}`);
    if (this.#token) url.searchParams.set('t', this.#token);
    const source = new EventSource(url.toString());
    source.onmessage = (event) => {
      try {
        onTick(JSON.parse(event.data) as TorrentStats);
      } catch {
        /* a truncated frame is not worth surfacing */
      }
    };
    // Let EventSource handle its own reconnection; only report that the feed is down.
    source.onerror = () => onTick({ active: false });
    return () => source.close();
  }

  #auth(): Record<string, string> {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  async #json<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw await this.#error(res);
    return (await res.json()) as T;
  }

  async #error(res: Response): Promise<ApiError> {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code: string; message: string } }
      | null;
    if (res.status === 401) this.signOut();
    return new ApiError(
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `request failed (${res.status})`,
      res.status
    );
  }
}
