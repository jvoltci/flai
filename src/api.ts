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

/* sessionStorage, not localStorage: the token is a bearer credential, so scoping it to the
 * tab means closing the tab ends the session. The password itself is never stored. */
export class ApiClient {
  #token: string | null = null;

  constructor(readonly baseUrl: string) {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const expiresAt = Number(sessionStorage.getItem(EXP_KEY) ?? 0);
    if (token && expiresAt > Date.now()) this.#token = token;
    else this.signOut();
  }

  get signedIn(): boolean {
    return this.#token !== null;
  }

  signOut(): void {
    this.#token = null;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXP_KEY);
  }

  async signIn(password: string): Promise<void> {
    const body = await this.#json<{ token: string; expiresAt: number }>('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    this.#token = body.token;
    sessionStorage.setItem(TOKEN_KEY, body.token);
    sessionStorage.setItem(EXP_KEY, String(body.expiresAt));
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
