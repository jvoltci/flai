/* Does it actually put bytes on disk?
 *
 * Everything else about this app is a window around one question, and a window is the one thing
 * that cannot be checked from a terminal. So this drives the same librqbit session the app
 * builds, against the real swarm, and looks at the resulting file.
 *
 * Network-dependent, so it is #[ignore] by default:
 *
 *   cargo test --test downloads -- --ignored --nocapture
 */
use std::time::Duration;

use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, Session};

/// Sintel — the Blender Foundation's own torrent, freely distributable. File 1 is a 1,514-byte
/// subtitle track, which is small enough to finish quickly and still proves the whole path.
const SINTEL: &str = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10\
&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce\
&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce\
&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce";

const SUBTITLE: &str = "Sintel.en.srt";
const SUBTITLE_LEN: u64 = 1514;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "talks to the real BitTorrent swarm"]
async fn downloads_a_file_to_disk() {
    let dir = std::env::temp_dir().join(format!("flai-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let session = Session::new(dir.clone()).await.expect("session");

    // Listing first is what the app does when you paste a magnet, and it is the step that has
    // to work before any of the rest matters.
    let listed = session
        .add_torrent(
            AddTorrent::from_url(SINTEL),
            Some(AddTorrentOptions {
                list_only: true,
                ..Default::default()
            }),
        )
        .await
        .expect("list");
    let files: Vec<(usize, String, u64)> = match listed {
        AddTorrentResponse::ListOnly(l) => l
            .info
            .iter_file_details()
            .unwrap()
            .enumerate()
            .map(|(i, d)| (i, d.filename.to_string().unwrap_or_default(), d.len))
            .collect(),
        _ => panic!("expected a listing"),
    };
    println!("listed {} files", files.len());
    let (index, name, len) = files
        .iter()
        .find(|(_, n, _)| n.ends_with(SUBTITLE))
        .cloned()
        .expect("the torrent should contain the English subtitles");
    assert_eq!(len, SUBTITLE_LEN, "file list reports the real length");

    let handle = session
        .add_torrent(
            AddTorrent::from_url(SINTEL),
            Some(AddTorrentOptions {
                only_files: Some(vec![index]),
                overwrite: true,
                ..Default::default()
            }),
        )
        .await
        .expect("add")
        .into_handle()
        .expect("handle");

    tokio::time::timeout(Duration::from_secs(180), handle.wait_until_completed())
        .await
        .expect("timed out waiting for peers — the swarm may be unreachable from here")
        .expect("download");

    /* Only that one file. Picking a subset has to mean the rest are not fetched, or "download
     * all" and "download one" are the same button.
     *
     * Not equal to the file length: BitTorrent's unit is the piece, and this torrent's pieces
     * are 128 KB, so a 1,514-byte subtitle costs one whole piece. The claim worth making is
     * that it cost one piece and not the 129 MB the full torrent weighs. */
    let stats = handle.stats();
    let whole_torrent = files.iter().map(|(_, _, len)| len).sum::<u64>();
    assert!(stats.finished, "reports finished");
    assert!(stats.total_bytes >= SUBTITLE_LEN, "at least the file itself");
    assert!(
        stats.total_bytes < whole_torrent / 100,
        "selecting one file fetched {} of {whole_torrent} bytes — that is not a subset",
        stats.total_bytes
    );

    let on_disk = dir.join("Sintel").join(&name);
    let bytes = std::fs::read(&on_disk).unwrap_or_else(|e| panic!("reading {on_disk:?}: {e}"));
    assert_eq!(bytes.len() as u64, SUBTITLE_LEN, "the file on disk is complete");
    /* Content, not a prefix: this one happens to begin with a newline, and the point of the
     * check is "real subtitles arrived" rather than "the first byte is what I guessed". Every
     * SRT cue carries the --> between its timestamps. */
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains(" --> "),
        "and it is really an SRT, not zeroes: {:?}",
        &text[..text.len().min(40)]
    );
    println!("downloaded {} ({} bytes) to {}", name, bytes.len(), on_disk.display());

    std::fs::remove_dir_all(&dir).ok();
}
