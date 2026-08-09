/* flai desktop — the same idea as the web app, without the borrowed constraints.
 *
 * The hosted bridge exists to squeeze BitTorrent through a 512 MB box with no disk: one file at
 * a time, a 32 MB sliding window, pieces thrown away as soon as they are sent. None of that is
 * a property of BitTorrent. It is the property of a free-tier server.
 *
 * Here there is a disk. So: every file at once, no window, no reader lock, no password, and the
 * session is persisted so closing the app and opening it tomorrow picks up where it left off.
 */
mod indexers;
mod service;
mod settings;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use librqbit::api::TorrentIdOrHash;
use librqbit::dht::PersistentDhtConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, Session, SessionOptions,
    SessionPersistenceConfig,
};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::Manager;


/// How often the background task checks whether a prioritised set has finished.
const RESTORE_TICK: Duration = Duration::from_secs(2);

/// Feeds are checked every this many ticks — fifteen minutes. Publishers measure their own
/// update rates in hours, so anything faster is bandwidth spent to learn nothing.
const FEED_TICKS: u64 = 15 * 60 / 2;

/* No tracker list here, and that is a measured decision rather than an omission.
 *
 * The obvious way to make a torrent faster is to tell it about more trackers, on the theory
 * that a download stuck at nine peers has not heard about enough of them. tests/peers.rs runs
 * that A-B-A on a real magnet, and it is simply not true. On the sparse 10 GB series this was
 * built against:
 *
 *   magnet's own trackers   726 peers seen, 18 connected
 *   + ten public trackers   665 peers seen, 16 connected
 *   magnet's own trackers   710 peers seen, 12 connected
 *
 * DHT already finds seven hundred peers. Fewer than three per cent of them can be connected to
 * — stale entries, firewalled hosts, peers that never unchoke. Discovery is not the limit, so
 * ten more trackers buy nothing and are ten more things to go stale.
 *
 * What does move the number is inbound connections, which is why the session asks for a UPnP
 * port forward: a peer that can dial you does not have to be dialled. That is also the one
 * advantage this app has over the hosted bridge, where the host allows no inbound at all. */

struct Engine {
    session: Arc<Session>,
    downloads: PathBuf,
    config_dir: PathBuf,
    /* Three things librqbit does not keep for us.
     *
     * `folders` — where each download was told to go. It lives on ManagedTorrentOptions, which
     * is pub(crate): librqbit's own HTTP API can read it and we cannot.
     *
     * `wanted` — the user's full selection, so priority can be undone. Once update_only_files
     * narrows a torrent, the original choice is gone.
     *
     * `priority` — which files are being fetched first, so the background task knows what to
     * restore and when. */
    folders: Mutex<HashMap<usize, String>>,
    wanted: Mutex<HashMap<usize, Vec<usize>>>,
    priority: Mutex<HashMap<usize, Vec<usize>>>,
    /// The user's own facts: proxy, indexers, feeds, queue depth, schedule, labels.
    config: Mutex<settings::Settings>,
    /// Torrents the queue or the schedule stopped — never the ones the user stopped.
    auto_paused: Mutex<HashSet<usize>>,
    /// Where librqbit's read-only HTTP server is listening, for handing a file to a player
    /// before it has finished downloading. 0 if it could not start.
    stream_port: u16,
}

impl Engine {
    fn folder_for(&self, id: usize) -> String {
        self.folders
            .lock()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| self.downloads.to_string_lossy().to_string())
    }

    fn save_config(&self) -> anyhow::Result<()> {
        settings::save(&self.config_dir, &self.config.lock())
    }
}

#[derive(Serialize)]
struct FileEntry {
    index: usize,
    name: String,
    length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TorrentInfo {
    info_hash: String,
    name: String,
    total: u64,
    files: Vec<FileEntry>,
}

/// One row of the details view: what this file is and how much of it is on disk.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileProgress {
    index: usize,
    name: String,
    length: u64,
    done: u64,
    /// Is it part of what this torrent is fetching at all?
    selected: bool,
    /// Is it in the set being fetched ahead of the others?
    first: bool,
}

/// Peer counts, split out because "12 peers" hides whether the other 200 were tried and failed.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Peers {
    live: usize,
    connecting: usize,
    queued: usize,
    seen: usize,
    dead: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TorrentRow {
    id: usize,
    info_hash: String,
    name: String,
    state: String,
    error: Option<String>,
    finished: bool,
    progress_bytes: u64,
    total_bytes: u64,
    uploaded_bytes: u64,
    /// Bytes per second, so the UI formats speed the same way it formats sizes.
    download_speed: u64,
    upload_speed: u64,
    peers: Peers,
    /// Seconds, or null when there is nothing to estimate from.
    eta_seconds: Option<u64>,
    output_folder: String,
    /// How many files are being fetched ahead of the rest. 0 when nothing is prioritised.
    priority_count: usize,
    file_count: usize,
    /// The user's own heading for this download, or empty. Feeds set it automatically.
    label: String,
    /// Stopped by the queue or the schedule rather than by the user, which the UI says out loud
    /// so a download that is not moving never looks like a download that is broken.
    queued: bool,
}

/// Tauri wants a serialisable error; anyhow gives good messages. This joins them.
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Names and lengths straight off a torrent's metadata, in file-index order.
fn file_list(
    info: &librqbit::TorrentMetaV1Info<librqbit::ByteBufOwned>,
) -> anyhow::Result<Vec<(String, u64)>> {
    Ok(info
        .iter_file_details()?
        .enumerate()
        .map(|(index, d)| {
            (
                // A torrent's filenames are arbitrary bytes, not guaranteed UTF-8. Name it
                // rather than drop it: a file called "file 3" is still downloadable, a missing
                // row is not.
                d.filename
                    .to_string()
                    .unwrap_or_else(|_| format!("file {index}")),
                d.len,
            )
        })
        .collect())
}

#[tauri::command]
async fn inspect(engine: tauri::State<'_, Engine>, magnet: String) -> Result<TorrentInfo, String> {
    let response = engine
        .session
        .add_torrent(
            AddTorrent::from_url(magnet.trim()),
            Some(AddTorrentOptions {
                list_only: true,
                ..Default::default()
            }),
        )
        .await
        .map_err(err)?;

    let listed = match response {
        AddTorrentResponse::ListOnly(listed) => listed,
        // Already downloading it. Read the file list off the live torrent instead.
        AddTorrentResponse::Added(_, handle) | AddTorrentResponse::AlreadyManaged(_, handle) => {
            let hash = handle.info_hash().as_string();
            return handle
                .with_metadata(|meta| describe(&hash, &meta.info))
                .map_err(err)?
                .map_err(err);
        }
    };

    describe(&listed.info_hash.as_string(), &listed.info).map_err(err)
}

fn describe(
    info_hash: &str,
    info: &librqbit::TorrentMetaV1Info<librqbit::ByteBufOwned>,
) -> anyhow::Result<TorrentInfo> {
    let files: Vec<FileEntry> = file_list(info)?
        .into_iter()
        .enumerate()
        .map(|(index, (name, length))| FileEntry {
            index,
            name,
            length,
        })
        .collect();
    Ok(TorrentInfo {
        info_hash: info_hash.to_string(),
        name: info
            .name
            .as_ref()
            .and_then(|n| std::str::from_utf8(n).ok())
            .unwrap_or(info_hash)
            .to_string(),
        total: files.iter().map(|f| f.length).sum(),
        files,
    })
}

#[tauri::command]
async fn start(
    engine: tauri::State<'_, Engine>,
    magnet: String,
    files: Vec<usize>,
    folder: Option<String>,
) -> Result<usize, String> {
    let chosen = folder
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| engine.downloads.to_string_lossy().to_string());

    let response = engine
        .session
        .add_torrent(
            AddTorrent::from_url(magnet.trim()),
            Some(AddTorrentOptions {
                // An empty selection means the whole torrent, which is what the web app could
                // never offer: there, every file is a separate one-at-a-time download.
                only_files: if files.is_empty() {
                    None
                } else {
                    Some(files.clone())
                },
                output_folder: Some(chosen.clone()),
                // Resuming a half-finished download is the normal case, not an accident.
                overwrite: true,
                ..Default::default()
            }),
        )
        .await
        .map_err(err)?;

    match response {
        AddTorrentResponse::Added(id, handle) | AddTorrentResponse::AlreadyManaged(id, handle) => {
            engine.folders.lock().insert(id, chosen);
            // Remember the full choice, so prioritising one file can be undone afterwards.
            let full = if files.is_empty() {
                handle
                    .with_metadata(|m| file_list(&m.info).map(|f| (0..f.len()).collect::<Vec<_>>()))
                    .ok()
                    .and_then(|r| r.ok())
                    .unwrap_or_default()
            } else {
                files
            };
            engine.wanted.lock().insert(id, full);
            Ok(id)
        }
        AddTorrentResponse::ListOnly(_) => Err("torrent was listed, not added".into()),
    }
}

#[tauri::command]
fn torrents(engine: tauri::State<'_, Engine>) -> Vec<TorrentRow> {
    engine.session.with_torrents(|iter| {
        iter.map(|(id, handle)| {
            let stats = handle.stats();
            let live = stats.live.as_ref();
            let down = live
                .map(|l| (l.download_speed.mbps * 125_000.0) as u64)
                .unwrap_or(0);
            TorrentRow {
                id,
                info_hash: handle.info_hash().as_string(),
                name: handle
                    .name()
                    .unwrap_or_else(|| handle.info_hash().as_string()),
                state: format!("{:?}", stats.state).to_lowercase(),
                error: stats.error.clone(),
                finished: stats.finished,
                progress_bytes: stats.progress_bytes,
                total_bytes: stats.total_bytes,
                uploaded_bytes: stats.uploaded_bytes,
                // librqbit reports megabits; the UI speaks bytes like everything else here.
                download_speed: down,
                upload_speed: live
                    .map(|l| (l.upload_speed.mbps * 125_000.0) as u64)
                    .unwrap_or(0),
                peers: live
                    .map(|l| {
                        let p = &l.snapshot.peer_stats;
                        Peers {
                            live: p.live,
                            connecting: p.connecting,
                            queued: p.queued,
                            seen: p.seen,
                            dead: p.dead,
                        }
                    })
                    .unwrap_or_default(),
                /* Computed rather than read. librqbit has a time_remaining, but it is a tuple
                 * struct with a private field and no accessor, so from outside the crate the
                 * only way to read it is to parse its Display. Dividing is honest and cheap. */
                eta_seconds: if down > 0 && stats.total_bytes > stats.progress_bytes {
                    Some((stats.total_bytes - stats.progress_bytes) / down)
                } else {
                    None
                },
                output_folder: engine.folder_for(id),
                priority_count: engine.priority.lock().get(&id).map_or(0, |p| p.len()),
                file_count: stats.file_progress.len(),
                label: engine
                    .config
                    .lock()
                    .labels
                    .get(&handle.info_hash().as_string())
                    .cloned()
                    .unwrap_or_default(),
                queued: engine.auto_paused.lock().contains(&id),
            }
        })
        .collect()
    })
}

/// Per-file detail for one download. Only asked for when a row is expanded.
#[tauri::command]
fn files(engine: tauri::State<'_, Engine>, id: usize) -> Result<Vec<FileProgress>, String> {
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .ok_or("no such download")?;
    let stats = handle.stats();
    let listed = handle
        .with_metadata(|m| file_list(&m.info))
        .map_err(err)?
        .map_err(err)?;

    let selected: Option<HashSet<usize>> = handle.only_files().map(|f| f.into_iter().collect());
    let first: HashSet<usize> = engine
        .priority
        .lock()
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();

    Ok(listed
        .into_iter()
        .enumerate()
        .map(|(index, (name, length))| FileProgress {
            index,
            name,
            length,
            done: stats.file_progress.get(index).copied().unwrap_or(0),
            selected: selected.as_ref().is_none_or(|s| s.contains(&index)),
            first: first.contains(&index),
        })
        .collect())
}

/* Fetch these files before the rest.
 *
 * BitTorrent has no priority in the sense a queue does — pieces arrive from whoever has them.
 * What it does have is selection, so "first" means: want only these for now, and put the rest
 * back when they are done. Which is what a priority actually buys you, and it is honest about
 * the fact that the other files stop meanwhile. */
#[tauri::command]
async fn prioritise(
    engine: tauri::State<'_, Engine>,
    id: usize,
    files: Vec<usize>,
) -> Result<(), String> {
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .ok_or("no such download")?;

    if files.is_empty() {
        return take_everything(engine, id).await;
    }

    // Remember the full selection the first time, or restoring later gives back only this file.
    {
        let mut wanted = engine.wanted.lock();
        wanted.entry(id).or_insert_with(|| {
            handle
                .only_files()
                .unwrap_or_else(|| (0..handle.stats().file_progress.len()).collect())
        });
    }

    let set: HashSet<usize> = files.iter().copied().collect();
    engine
        .session
        .update_only_files(&handle, &set)
        .await
        .map_err(err)?;
    engine.priority.lock().insert(id, files);
    Ok(())
}

#[tauri::command]
async fn take_everything(engine: tauri::State<'_, Engine>, id: usize) -> Result<(), String> {
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .ok_or("no such download")?;
    let full = engine.wanted.lock().get(&id).cloned();
    if let Some(full) = full {
        let set: HashSet<usize> = full.into_iter().collect();
        engine
            .session
            .update_only_files(&handle, &set)
            .await
            .map_err(err)?;
    }
    engine.priority.lock().remove(&id);
    Ok(())
}

#[tauri::command]
async fn pause(engine: tauri::State<'_, Engine>, id: usize) -> Result<(), String> {
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .ok_or("no such download")?;
    engine.session.pause(&handle).await.map_err(err)
}

#[tauri::command]
async fn resume(engine: tauri::State<'_, Engine>, id: usize) -> Result<(), String> {
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .ok_or("no such download")?;
    engine.session.unpause(&handle).await.map_err(err)
}

#[tauri::command]
async fn forget(
    engine: tauri::State<'_, Engine>,
    id: usize,
    delete_files: bool,
) -> Result<(), String> {
    engine
        .session
        .delete(TorrentIdOrHash::Id(id), delete_files)
        .await
        .map_err(err)?;
    engine.folders.lock().remove(&id);
    engine.wanted.lock().remove(&id);
    engine.priority.lock().remove(&id);
    Ok(())
}

/* Hands a finished download to another app.
 *
 * flai has no video player and is not getting one. What people actually download is HEVC with
 * EAC3 audio, which a WebView cannot play, and doing it properly means Media3 plus the FFmpeg
 * extension — days of work to land behind VLC. Handing the file over gets every codec the
 * device's hardware supports, and subtitles for free: a torrent ships Movie.mkv beside
 * Movie.en.srt, and every serious player picks up a matching .srt by itself. */
#[tauri::command]
fn default_folder(engine: tauri::State<'_, Engine>) -> String {
    engine.downloads.to_string_lossy().to_string()
}

#[tauri::command]
fn open_download(path: String) -> Result<(), String> {
    service::open(&path).map_err(err)
}

/* Play it now, before it has finished.
 *
 * The URL points at librqbit's own read-only server on localhost, and the trailing filename is
 * not decoration: players choose a demuxer by extension, and VLC handed a URL ending in `/0`
 * will guess wrong on exactly the containers people download. The path segment carries `.mkv`
 * through so it does not have to guess.
 */
#[tauri::command]
fn play(engine: tauri::State<'_, Engine>, id: usize, file: usize) -> Result<(), String> {
    let url = stream_url(&engine, id, file).map_err(err)?;

    // Two platforms, one command, so the UI never has to ask which one it is on.
    //
    // Android needs the intent to declare a video MIME type, or it is a browsing intent and the
    // browser answers it by downloading the file a second time. A desktop already has a
    // registered handler for http, and tauri's opener knows how to reach it on all three.
    #[cfg(target_os = "android")]
    return service::open_stream(&url).map_err(err);

    #[cfg(not(target_os = "android"))]
    return tauri_plugin_opener::open_url(&url, None::<&str>).map_err(err);
}

fn stream_url(engine: &Engine, id: usize, file: usize) -> anyhow::Result<String> {
    if engine.stream_port == 0 {
        anyhow::bail!("the local stream server did not start");
    }
    let handle = engine
        .session
        .get(TorrentIdOrHash::Id(id))
        .context("that download is gone")?;
    let listed = handle.with_metadata(|m| file_list(&m.info))??;
    let name = listed
        .get(file)
        .map(|(name, _)| name.rsplit('/').next().unwrap_or(name).to_string())
        .context("no such file in that torrent")?;

    Ok(format!(
        "http://127.0.0.1:{}/torrents/{id}/stream/{file}/{}",
        engine.stream_port,
        urlencode(&name)
    ))
}

/// Enough percent-encoding for a filename in a path segment. Not a general encoder, and not
/// trying to be: torrent filenames contain spaces, brackets and quotes, and every one of those
/// either breaks the URL or gets silently mangled by some player.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tauri::command]
fn get_settings(engine: tauri::State<'_, Engine>) -> settings::Settings {
    engine.config.lock().clone()
}

/* Saving settings deliberately does not restart anything.
 *
 * The queue depth and the schedule are read fresh on every supervisor tick, so those take effect
 * within two seconds. The proxy cannot: librqbit builds its connector once when the session
 * starts and hands it to every peer connection. Returning whether a restart is needed lets the
 * UI say so plainly, which is better than a proxy setting that appears to save and does nothing.
 */
#[tauri::command]
fn set_settings(
    engine: tauri::State<'_, Engine>,
    incoming: settings::Settings,
) -> Result<bool, String> {
    let proxy_changed = {
        let mut config = engine.config.lock();
        let changed = config.socks_proxy.trim() != incoming.socks_proxy.trim();
        *config = incoming;
        changed
    };
    engine.save_config().map_err(err)?;
    Ok(proxy_changed)
}

#[tauri::command]
async fn search(engine: tauri::State<'_, Engine>, query: String) -> Result<Vec<indexers::Hit>, String> {
    let configured = engine.config.lock().indexers.clone();
    if configured.is_empty() {
        return Err("no indexers configured yet".into());
    }
    Ok(indexers::search(&configured, query.trim()).await)
}

/// Adds a search result or a pasted .torrent URL whole, which is what you want from a search:
/// picking files comes from the details view afterwards.
#[tauri::command]
async fn add_result(
    engine: tauri::State<'_, Engine>,
    url: String,
    label: String,
) -> Result<usize, String> {
    add_url(&engine, url.trim(), label.trim()).await.map_err(err)
}

#[tauri::command]
fn set_label(
    engine: tauri::State<'_, Engine>,
    info_hash: String,
    label: String,
) -> Result<(), String> {
    {
        let mut config = engine.config.lock();
        if label.trim().is_empty() {
            config.labels.remove(&info_hash);
        } else {
            config.labels.insert(info_hash, label.trim().to_string());
        }
    }
    engine.save_config().map_err(err)
}

/// Where downloads go: the real Downloads folder, the one every other app uses.
///
/// This had a special case that wrote to app_data_dir — /data/user/0/<pkg>, which needs root to
/// open. Downloads finished and were invisible. The obvious repair was the app-specific external
/// folder, and it is only half a repair: it needs no permission, but Android 11+ hides
/// Android/data from the Files app, so the download is still somewhere its owner cannot reach.
///
/// The only way a path-writing torrent engine reaches /storage/emulated/0/Download is all-files
/// access. MediaStore and the Storage Access Framework both answer in content:// URIs, and
/// librqbit writes paths. LibreTorrent declares the same permission for the same reason.
///
/// If it is refused, this falls back to the app folder — worse to find, but still working.
fn default_downloads(app: &tauri::App) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        // Not a guess: /storage/emulated/0/Download is the public Downloads folder on every
        // Android device for the primary user. Probed rather than assumed, so a device that
        // does things differently, or a refused permission, falls through instead of failing.
        let public = PathBuf::from("/storage/emulated/0/Download/flai");
        if std::fs::create_dir_all(&public).is_ok() {
            if is_writable(&public) {
                return public;
            }
            // Measured: without all-files access, Android lets the directory be created and
            // then refuses the write. Take the empty folder back out rather than leaving a
            // stray flai/ in everyone's Downloads.
            std::fs::remove_dir(&public).ok();
        }
    }
    app.path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("downloads")))
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// create_dir_all can succeed on a path that is still not writable, so this actually writes.
#[allow(dead_code)]
fn is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".flai-write-test");
    let ok = std::fs::write(&probe, b"x").is_ok();
    std::fs::remove_file(&probe).ok();
    ok
}

/// Moves anything stranded in the old, unreachable location into the new one.
///
/// Runs once at startup and is a no-op after that. Rescuing a finished download beats
/// apologising for it.
fn rescue_stranded_downloads(app: &tauri::App, target: &std::path::Path) {
    let Ok(old) = app.path().app_data_dir().map(|d| d.join("downloads")) else {
        return;
    };
    if !old.exists() || old == target {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&old) else { return };
    let mut moved = 0usize;
    for entry in entries.flatten() {
        let to = target.join(entry.file_name());
        if to.exists() {
            continue;
        }
        // Rename first: same filesystem, so it is instant and does not need twice the space.
        // A 10 GB copy on a phone is not a fallback anyone wants by surprise.
        if std::fs::rename(entry.path(), &to).is_ok() {
            moved += 1;
        }
    }
    if moved > 0 {
        eprintln!("flai: moved {moved} stranded download(s) into {}", target.display());
    }
    std::fs::remove_dir(&old).ok();
}

/* What the notification says, or None when nothing is running.
 *
 * On Android this is the difference between downloading and being suspended, so it counts what
 * is actually moving rather than what exists: a finished torrent left seeding is not a reason
 * to hold the CPU awake, and neither is a paused one. */
fn downloading_summary(session: &Arc<Session>) -> Option<String> {
    let (active, speed, done, total) = session.with_torrents(|iter| {
        let mut active = 0usize;
        let mut speed = 0f64;
        let mut done = 0u64;
        let mut total = 0u64;
        for (_, handle) in iter {
            let stats = handle.stats();
            if stats.finished || handle.is_paused() {
                continue;
            }
            if let Some(live) = stats.live.as_ref() {
                active += 1;
                speed += live.download_speed.mbps;
                done += stats.progress_bytes;
                total += stats.total_bytes;
            }
        }
        (active, speed, done, total)
    });

    if active == 0 {
        return None;
    }
    let percent = if total > 0 { done * 100 / total } else { 0 };
    let mbps = speed * 125_000.0 / 1_048_576.0;
    Some(format!(
        "{active} download{} · {percent}% · {mbps:.1} MB/s",
        if active == 1 { "" } else { "s" }
    ))
}

/* Playing a file before it has finished downloading.
 *
 * This is librqbit's own HTTP server, turned on rather than written. Its stream route does Range
 * requests, seeking, and blocking until the piece under the playhead has actually arrived —
 * which is the hard half, and the half that is silently wrong if you write it yourself. librqbit
 * also downloads sequentially by default, so the pieces arrive in the order a player wants them.
 *
 * Started read-only, so every route that changes anything is simply not mounted, and bound to
 * 127.0.0.1 on a port the kernel picks. Other apps on the phone can reach localhost, so read-only
 * is doing real work here: the most another app could do is read a file that is already on the
 * device's own storage.
 *
 * Returns 0 if it could not start, which costs nothing — the app just does not offer Play.
 */
fn start_stream_server(session: Arc<Session>) -> u16 {
    use librqbit::http_api::{HttpApi, HttpApiOptions};

    let Ok(listener) = tauri::async_runtime::block_on(tokio::net::TcpListener::bind((
        std::net::Ipv4Addr::LOCALHOST,
        0,
    ))) else {
        return 0;
    };
    let Ok(addr) = listener.local_addr() else {
        return 0;
    };

    let http = HttpApi::new(
        // The second and third are a log-reload channel and a log broadcast. Neither is wanted:
        // this server exists to hand bytes to a video player, not to stream logs to anyone.
        librqbit::Api::new(session, None, None),
        Some(HttpApiOptions {
            read_only: true,
            ..Default::default()
        }),
    );
    tauri::async_runtime::spawn(async move {
        let _ = http.make_http_api_and_run(listener, None).await;
    });
    addr.port()
}

/* One loop, four jobs, because they all ask "what is happening right now" and four timers would
 * wake the CPU four times to find out. On a phone that is the difference between a download that
 * costs battery and one that costs noticeably more.
 *
 * In the app rather than in the window: a queue that only advances while the UI happens to be
 * polling is a queue that stalls the moment somebody minimises the app. */
fn supervise(session: Arc<Session>, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            tokio::time::sleep(RESTORE_TICK).await;
            ticks += 1;
            let engine = app.state::<Engine>();

            service::set(downloading_summary(&session));
            restore_priorities(&engine, &session).await;
            enforce_queue(&engine, &session).await;

            if ticks % FEED_TICKS == 0 {
                poll_feeds(&engine).await;
            }
        }
    });
}

/// Puts the rest of the files back once the prioritised ones have landed.
async fn restore_priorities(engine: &Engine, session: &Arc<Session>) {
    let pending: Vec<(usize, Vec<usize>)> = engine
        .priority
        .lock()
        .iter()
        .map(|(id, files)| (*id, files.clone()))
        .collect();

    for (id, files) in pending {
        let Some(handle) = session.get(TorrentIdOrHash::Id(id)) else {
            engine.priority.lock().remove(&id);
            continue;
        };
        let stats = handle.stats();
        let Ok(Ok(listed)) = handle.with_metadata(|m| file_list(&m.info)) else {
            continue;
        };
        let done = files.iter().all(|&i| {
            let have = stats.file_progress.get(i).copied().unwrap_or(0);
            listed.get(i).is_some_and(|(_, len)| have >= *len)
        });
        if !done {
            continue;
        }
        let full = engine.wanted.lock().get(&id).cloned();
        if let Some(full) = full {
            let set: HashSet<usize> = full.into_iter().collect();
            let _ = session.update_only_files(&handle, &set).await;
        }
        engine.priority.lock().remove(&id);
    }
}

/* The queue and the schedule, which are one decision: how many torrents may run right now.
 *
 * Outside the allowed hours that number is zero, otherwise it is max_active, otherwise there is
 * no limit and this does nothing at all.
 *
 * `auto_paused` is what keeps this honest. A torrent the user paused by hand and a torrent the
 * queue parked look identical to librqbit, so without a record of which ones this function
 * stopped, the first time the queue advanced it would helpfully un-pause everything the user had
 * deliberately stopped. Only what this paused is ever resumed by it.
 */
async fn enforce_queue(engine: &Engine, session: &Arc<Session>) {
    let (limit, schedule) = {
        let config = engine.config.lock();
        (config.max_active, config.schedule)
    };
    let within = schedule.is_none_or(|s| s.allows(settings::minute_utc_now()));

    // None means no limit at all. Outside the allowed hours the limit is zero, which is the same
    // code path as a full queue and needs no special case.
    let allowed: Option<usize> = match (within, limit) {
        (false, _) => Some(0),
        (true, 0) => None,
        (true, n) => Some(n),
    };

    // Oldest first, so the queue is a queue rather than a lottery.
    let mut ids: Vec<usize> = session.with_torrents(|iter| {
        iter.filter(|(_, handle)| !handle.stats().finished)
            .map(|(id, _)| id)
            .collect()
    });
    ids.sort_unstable();

    let mut running = 0usize;
    for id in ids {
        let Some(handle) = session.get(TorrentIdOrHash::Id(id)) else {
            continue;
        };
        let parked = engine.auto_paused.lock().contains(&id);
        let paused = handle.is_paused();

        // A torrent the user paused stays paused, and takes no slot from the ones that want one.
        if paused && !parked {
            continue;
        }

        if allowed.is_none_or(|n| running < n) {
            running += 1;
            if parked {
                let _ = session.unpause(&handle).await;
                engine.auto_paused.lock().remove(&id);
            }
        } else if !paused {
            let _ = session.pause(&handle).await;
            engine.auto_paused.lock().insert(id);
        }
    }
}

/// Polls every feed and adds whatever is new. Failures are per-feed and silent: a feed that is
/// down is a feed that has nothing new, and it will be asked again in fifteen minutes.
async fn poll_feeds(engine: &Engine) {
    let feeds = engine.config.lock().feeds.clone();
    for feed in &feeds {
        let Ok((fresh, guids)) = indexers::poll(feed).await else {
            continue;
        };
        if fresh.is_empty() {
            continue;
        }
        for hit in &fresh {
            let _ = add_url(engine, &hit.url, &feed.label).await;
        }
        {
            let mut config = engine.config.lock();
            /* Found by URL rather than by the index it had when this loop started. Polling a
             * feed takes seconds and the settings screen can save in the middle of it, which
             * reorders the list — writing `seen` back by index would then attribute one feed's
             * downloads to another and re-download the lot. */
            let Some(stored) = config.feeds.iter_mut().find(|f| f.url == feed.url) else {
                continue;
            };
            stored.seen.extend(guids);
            /* Bounded, because `seen` is written to disk on every poll and a busy feed would
             * otherwise grow it without limit. Two hundred is far more than any feed shows at
             * once, so an item can never fall off the list while it is still being published. */
            let overflow = stored.seen.len().saturating_sub(200);
            stored.seen.drain(..overflow);
        }
        let _ = engine.save_config();
    }
}

/// Adds a whole torrent from a magnet or .torrent URL, into the default folder, under a label.
async fn add_url(engine: &Engine, url: &str, label: &str) -> anyhow::Result<usize> {
    let folder = engine.downloads.to_string_lossy().to_string();
    let response = engine
        .session
        .add_torrent(
            AddTorrent::from_url(url),
            Some(AddTorrentOptions {
                output_folder: Some(folder.clone()),
                overwrite: true,
                ..Default::default()
            }),
        )
        .await?;

    let (id, handle) = match response {
        AddTorrentResponse::Added(id, handle) | AddTorrentResponse::AlreadyManaged(id, handle) => {
            (id, handle)
        }
        AddTorrentResponse::ListOnly(_) => anyhow::bail!("torrent was listed, not added"),
    };

    engine.folders.lock().insert(id, folder);
    if !label.is_empty() {
        engine
            .config
            .lock()
            .labels
            .insert(handle.info_hash().as_string(), label.to_string());
        let _ = engine.save_config();
    }
    Ok(id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(service::plugin())
        .setup(|app| {
            let downloads = default_downloads(app);
            std::fs::create_dir_all(&downloads).ok();
            let config_dir = app.path().app_config_dir()?;

            /* Persisted, which is the whole difference between this and the web app. A
             * download interrupted by closing the app — or by a reboot — is still there next
             * time, at the byte it reached.
             *
             * Both paths are given explicitly, and that is not tidiness. Left to itself
             * librqbit asks the `directories` crate where to put the session and the DHT
             * routing table, which is right on a desktop and wrong on Android, where the answer
             * is a path the app cannot write. The first Android build died on launch with
             * "error initializing persistent DHT" before the window ever appeared. Pointing
             * both at Tauri's own app-config directory works everywhere, because that is the
             * one directory every platform guarantees us. */
            let session_dir = config_dir.join("session");
            std::fs::create_dir_all(&session_dir)?;

            let config = settings::load(&config_dir);

            let session = tauri::async_runtime::block_on(Session::new_with_opts(
                downloads.clone(),
                SessionOptions {
                    persistence: Some(SessionPersistenceConfig::Json {
                        folder: Some(session_dir.clone()),
                    }),
                    dht_config: Some(PersistentDhtConfig {
                        config_filename: Some(session_dir.join("dht.json")),
                        ..Default::default()
                    }),
                    enable_upnp_port_forwarding: true,
                    /* Fixed for the life of the session, which is librqbit's design rather than
                     * a shortcut here: the connector is built once and handed to every peer
                     * connection. Changing the proxy therefore means restarting the app, and the
                     * UI says so instead of pretending otherwise. */
                    socks_proxy_url: Some(config.socks_proxy.clone())
                        .filter(|url| !url.trim().is_empty()),
                    ..Default::default()
                },
            ))?;

            rescue_stranded_downloads(app, &downloads);

            let stream_port = start_stream_server(session.clone());

            app.manage(Engine {
                session: session.clone(),
                downloads,
                config_dir,
                folders: Mutex::new(HashMap::new()),
                wanted: Mutex::new(HashMap::new()),
                priority: Mutex::new(HashMap::new()),
                config: Mutex::new(config),
                auto_paused: Mutex::new(HashSet::new()),
                stream_port,
            });
            supervise(session, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect,
            start,
            torrents,
            files,
            prioritise,
            take_everything,
            pause,
            resume,
            forget,
            default_folder,
            open_download,
            play,
            get_settings,
            set_settings,
            search,
            add_result,
            set_label
        ])
        .build(tauri::generate_context!())
        .expect("error while running flai")
        .run(handle_run_event);
}

/* Keeping the process alive on Android without losing the window.
 *
 * These two arms are one bug, from two directions. A foreground service holds the process open
 * after the last activity dies — that is the whole point, it is what lets a download survive
 * being swiped out of recents. Tauri then reopens the app into the same live process, and
 * tauri-apps/tauri#15671 is what happens next: a blank white screen, no webview, JavaScript
 * never runs, and only force-stopping it recovers. The activity comes back with a fresh
 * hashCode, so Tauri's activity-to-window map never finds the window it stored, and the runtime
 * drops the resume event because no webviews exist to deliver it to.
 *
 * Unfixed as of 2.11.5. Recreating the window from the same config `setup()` uses is the
 * workaround the reporter validated, and it is a no-op in the normal case because a window is
 * already there.
 */
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    let _ = app;
    #[cfg(target_os = "android")]
    match event {
        // Closing the last window must not end the process while bytes are still moving.
        tauri::RunEvent::ExitRequested { ref api, .. } => {
            // try_state, not state: this can fire before setup() has managed the Engine, and
            // state() panics where this simply has nothing to protect yet.
            let busy = app
                .try_state::<Engine>()
                .is_some_and(|engine| downloading_summary(&engine.session).is_some());
            if busy {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Resumed => {
            if !app.webview_windows().is_empty() {
                return;
            }
            for config in &app.config().app.windows {
                let _ = tauri::WebviewWindowBuilder::from_config(app, config)
                    .and_then(|builder| builder.build());
            }
        }
        _ => {}
    }
    #[cfg(not(target_os = "android"))]
    let _ = event;
}
