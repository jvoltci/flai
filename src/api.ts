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
  files: FileEntry[];
}

export interface ApiError {
  code: string;
  message: string;
}

export class ApiClient {
  constructor(public readonly baseUrl: string) {}

  async metadata(magnet: string, password: string, signal?: AbortSignal): Promise<Metadata> {
    const r = await fetch(`${this.baseUrl}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: magnet, password }),
      signal,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error?.message ?? `request failed (${r.status})`);
    return body as Metadata;
  }

  fileUrl(infoHash: string, fileIndex: number, attachment = false): string {
    const url = new URL(`${this.baseUrl}/torrent/${infoHash}/${fileIndex}`);
    if (attachment) url.searchParams.set('dl', '1');
    return url.toString();
  }

  zipUrl(infoHash: string): string {
    return `${this.baseUrl}/torrent/${infoHash}`;
  }
}
