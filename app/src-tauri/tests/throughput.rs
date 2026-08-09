/* librqbit's throughput on the same magnet, in the same conditions, as a comparison client.
 *
 * The question this answers: when a torrent is slow in flai, is that the swarm or is it us?
 * Transmission has protocol encryption (MSE) and uTP; librqbit 8.1.1 has neither. If an ISP
 * shapes plain BitTorrent TCP, that difference is the whole difference.
 *
 *   cargo test --test throughput -- --ignored --nocapture
 */
use std::time::{Duration, Instant};

use librqbit::{AddTorrent, AddTorrentOptions, Session};

const WATCH: Duration = Duration::from_secs(150);

#[tokio::test(flavor = "multi_thread")]
#[ignore = "talks to the real swarm for 150s"]
async fn how_fast_is_librqbit() {
    let magnet = std::env::var("FLAI_MAGNET").expect("set FLAI_MAGNET");
    let dir = std::env::temp_dir().join(format!("flai-tp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let session = Session::new(dir.clone()).await.expect("session");
    let handle = session
        .add_torrent(
            AddTorrent::from_url(&magnet),
            Some(AddTorrentOptions { overwrite: true, ..Default::default() }),
        )
        .await
        .expect("add")
        .into_handle()
        .expect("handle");

    let start = Instant::now();
    while start.elapsed() < WATCH {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let s = handle.stats();
        let (mbps, live) = s
            .live
            .as_ref()
            .map(|l| (l.download_speed.mbps, l.snapshot.peer_stats.live))
            .unwrap_or((0.0, 0));
        println!(
            "  t={:>3}s  {:>7.1} MB have  {:>6.2} MB/s  {live} peers",
            start.elapsed().as_secs(),
            s.progress_bytes as f64 / 1_048_576.0,
            mbps * 125_000.0 / 1_048_576.0,
        );
    }

    let s = handle.stats();
    println!(
        "\n  RESULT: {:.1} MB in {}s = {:.2} MB/s average",
        s.progress_bytes as f64 / 1_048_576.0,
        WATCH.as_secs(),
        s.progress_bytes as f64 / 1_048_576.0 / WATCH.as_secs() as f64
    );
    session.delete(handle.id().into(), true).await.ok();
    std::fs::remove_dir_all(&dir).ok();
}
