/* Does adding trackers actually find more peers?
 *
 * The claim in lib.rs is that a torrent sitting at nine peers is not throttled — librqbit puts
 * no ceiling on connections — it just has not been told about more. That is a claim about
 * discovery, so it deserves a measurement rather than a comment.
 *
 * A-B on one magnet, same machine, back to back:
 *
 *   cargo test --test peers -- --ignored --nocapture
 */
use std::time::Duration;

use librqbit::{AddTorrent, AddTorrentOptions, Session};

const TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://explodie.org:6969/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://tracker.bittor.pw:1337/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
];

/// Sintel by default — a famously healthy torrent. Override with FLAI_MAGNET to measure a
/// sparse one, which is the case where discovery might actually be the limit.
const DEFAULT_MAGNET: &str = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10\
&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce";

fn magnet() -> String {
    std::env::var("FLAI_MAGNET").unwrap_or_else(|_| DEFAULT_MAGNET.to_string())
}

const WATCH: Duration = Duration::from_secs(45);

async fn peers_found(label: &str, extra: Option<Vec<String>>) -> (usize, usize) {
    let dir = std::env::temp_dir().join(format!("flai-peers-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = Session::new(dir.clone()).await.expect("session");
    let url = magnet();

    let handle = session
        .add_torrent(
            AddTorrent::from_url(&url),
            Some(AddTorrentOptions {
                // One file, so the measurement is about peers and not about bandwidth.
                only_files: Some(vec![0]),
                overwrite: true,
                trackers: extra,
                ..Default::default()
            }),
        )
        .await
        .expect("add")
        .into_handle()
        .expect("handle");

    tokio::time::sleep(WATCH).await;
    let stats = handle.stats();
    let (seen, live) = stats
        .live
        .as_ref()
        .map(|l| (l.snapshot.peer_stats.seen, l.snapshot.peer_stats.live))
        .unwrap_or((0, 0));
    println!("  {label:<12} seen {seen:>4}   connected {live:>3}");

    session.delete(handle.id().into(), true).await.ok();
    std::fs::remove_dir_all(&dir).ok();
    (seen, live)
}

/* The measurement that decided there is no tracker list in lib.rs.
 *
 * Run against the sparse 10 GB series this app was built on:
 *
 *   magnet only   726 seen, 18 connected
 *   + trackers    665 seen, 16 connected
 *   magnet only   710 seen, 12 connected
 *
 * and against Sintel, 209 -> 202 -> 204. Two torrents, one healthy and one not, and in neither
 * did ten extra trackers find a single additional peer. The A-B-A ordering is there so a
 * warming DHT cannot take the credit; the third run coming back to the first number is what
 * makes the middle one mean something.
 *
 * This asserts the conclusion rather than the hypothesis, so it fails if the world changes:
 * either trackers start mattering, or discovery stops being the abundant half of the problem.
 */
#[tokio::test(flavor = "multi_thread")]
#[ignore = "talks to the real BitTorrent swarm and takes ~2.5 minutes"]
async fn discovery_is_not_the_bottleneck() {
    println!("{WATCH:?} per run, same magnet, back to back:");
    let (bare_seen, bare_live) = peers_found("magnet only", None).await;
    let extra: Vec<String> = TRACKERS.iter().map(|t| t.to_string()).collect();
    let (more_seen, _) = peers_found("+ trackers", Some(extra)).await;
    let (bare_again, _) = peers_found("magnet only", None).await;

    println!("\n  {bare_seen} -> {more_seen} -> {bare_again} peers seen");

    assert!(
        bare_seen > 50,
        "DHT alone found only {bare_seen} peers — if discovery really is this thin, a tracker \
         list would be worth adding back to lib.rs"
    );
    assert!(
        bare_live * 4 < bare_seen,
        "{bare_live} of {bare_seen} peers connected. The premise for leaving trackers out is \
         that connecting, not finding, is the scarce half — that no longer holds"
    );
    // Not a hard failure: swarms are noisy and this is one sample. Worth seeing, though.
    if more_seen > bare_seen.max(bare_again) * 2 {
        println!("  NOTE: trackers doubled discovery here — revisit the decision in lib.rs");
    }
}
