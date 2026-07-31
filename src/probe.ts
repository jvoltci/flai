/* Can this browser actually play the file, and if not, why not.
 *
 * v3 marked a file `streamable` from its extension alone, handed .mkv to a <video> element,
 * and showed an empty player when Chrome refused it. That is the "playback fails on some
 * files" bug, and the fix is not a transcoder — it is telling the truth.
 *
 * Two signals, cheap first:
 *
 *   1. canPlayType() on the container. Free, no network, and decisive: Chrome answers ''
 *      for video/x-matroska no matter what is inside it.
 *   2. A 256 KB read of the file header to name the codecs, so the message can say
 *      "H.265 video, AC-3 audio" instead of "unsupported". That turns a dead end into a
 *      decision: VLC plays this fine over the same URL.
 *
 * No WASM remuxer. It would rescue exactly one case — H.264 in MKV — at the cost of a 2-3 MB
 * payload, a worker, and a MediaSource pipeline to maintain, and it still could not help
 * H.265 or DTS. The external-player handoff covers every case for the price of a button.
 */

export type Playability = 'plays' | 'partial' | 'no' | 'unknown';

export interface Verdict {
  playability: Playability;
  container: string;
  codecs: string[];
  reason: string;
}

const ascii = (bytes: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...bytes.subarray(at, at + len));

function detectContainer(b: Uint8Array): string {
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    return brand.startsWith('qt') ? 'QuickTime' : 'MP4';
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // Both share the EBML header; the DocType tells them apart.
    return findAscii(b, ['webm']).length ? 'WebM' : 'Matroska';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return 'AVI';
  if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') return 'Ogg';
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return 'MPEG-TS';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'MP3';
  return 'unknown';
}

/** Byte-scan for ASCII markers. Crude next to a real demuxer, and enough to name a codec. */
function findAscii(b: Uint8Array, needles: string[]): string[] {
  const text = String.fromCharCode(...b);
  return needles.filter((n) => text.includes(n));
}

const MP4_CODECS: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'H.265',
  hev1: 'H.265',
  av01: 'AV1',
  vp09: 'VP9',
  mp4a: 'AAC',
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  Opus: 'Opus',
  fLaC: 'FLAC',
  alac: 'ALAC',
};

const MKV_CODECS: Record<string, string> = {
  'V_MPEGH/ISO/HEVC': 'H.265',
  'V_MPEG4/ISO/AVC': 'H.264',
  'V_MPEG4/ISO/ASP': 'MPEG-4 ASP',
  V_AV1: 'AV1',
  V_VP9: 'VP9',
  V_VP8: 'VP8',
  A_AAC: 'AAC',
  A_AC3: 'AC-3',
  A_EAC3: 'E-AC-3',
  A_OPUS: 'Opus',
  A_VORBIS: 'Vorbis',
  A_FLAC: 'FLAC',
  A_DTS: 'DTS',
  A_TRUEHD: 'TrueHD',
  'A_MPEG/L3': 'MP3',
};

/** Codecs Chrome will not decode even inside a container it accepts. */
const UNDECODABLE = new Set(['DTS', 'TrueHD', 'AC-3', 'E-AC-3', 'MPEG-4 ASP', 'ALAC']);

function detectCodecs(container: string, b: Uint8Array): string[] {
  const table = container === 'Matroska' || container === 'WebM' ? MKV_CODECS : MP4_CODECS;
  const hits = findAscii(b, Object.keys(table)).map((k) => table[k]!);
  return [...new Set(hits)];
}

function canPlayContainer(contentType: string): boolean {
  const probe = document.createElement('video');
  return probe.canPlayType(contentType) !== '';
}

export async function probeFile(url: string, contentType: string): Promise<Verdict> {
  const containerOk = canPlayContainer(contentType);

  let bytes: Uint8Array | null = null;
  try {
    // The bridge refuses an un-ranged request, and 256 KB is enough for ftyp/moov or the
    // Matroska Tracks element on everything seen in practice.
    const res = await fetch(url, { headers: { Range: 'bytes=0-262143' } });
    if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    else if (res.status === 409) {
      return {
        playability: 'unknown',
        container: 'unknown',
        codecs: [],
        reason: 'the bridge is busy with a download on this torrent — pause it to inspect this file',
      };
    }
  } catch {
    /* fall through to the container-only verdict */
  }

  if (!bytes) {
    return {
      playability: containerOk ? 'plays' : 'no',
      container: 'unknown',
      codecs: [],
      reason: containerOk
        ? 'the container is one this browser plays; could not read the header to check codecs'
        : `this browser does not play ${contentType} containers`,
    };
  }

  const container = detectContainer(bytes);
  const codecs = detectCodecs(container, bytes);
  const blocked = codecs.filter((c) => UNDECODABLE.has(c));

  if (!containerOk) {
    const inside = codecs.length ? ` It holds ${codecs.join(' + ')}.` : '';
    return {
      playability: 'no',
      container,
      codecs,
      reason: `Chrome cannot play a ${container} container.${inside} VLC, mpv and IINA play it straight from the stream URL.`,
    };
  }

  if (blocked.length) {
    return {
      playability: 'partial',
      container,
      codecs,
      reason: `${blocked.join(' and ')} is not something this browser decodes, so expect no sound or no picture. An external player handles it.`,
    };
  }

  return {
    playability: 'plays',
    container,
    codecs,
    reason: codecs.length ? `${container}, ${codecs.join(' + ')}.` : `${container}.`,
  };
}

/** A one-line playlist. Opening it hands the stream to whatever plays .m3u — VLC, mpv, IINA —
 *  which beats asking someone to copy a URL into a dialog. */
export function playlistBlobUrl(streamUrl: string, name: string): string {
  const body = `#EXTM3U\n#EXTINF:-1,${name}\n${streamUrl}\n`;
  return URL.createObjectURL(new Blob([body], { type: 'audio/x-mpegurl' }));
}
