/* flai desktop — the same idea as the web app, without the borrowed constraints.
 *
 * The hosted bridge exists to squeeze BitTorrent through a 512 MB box with no disk: one file at
 * a time, a 32 MB sliding window, pieces thrown away as soon as they are sent. None of that is
 * a property of BitTorrent. It is the property of a free-tier server.
 *
 * Here there is a disk. So: every file at once, no window, no reader lock, no password, and the
 * session is persisted so closing the app and opening it tomorrow picks up where it left off.
 */
mod service;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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
}

impl Engine {
    fn folder_for(&self, id: usize) -> String {
        self.folders
            .lock()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| self.downloads.to_string_lossy().to_string())
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

/* Puts the rest of the files back once the prioritised ones have landed.
 *
 * In the app rather than in the window, because a priority that only resolves while the UI
 * happens to be polling is a priority that gets stuck the moment somebody minimises the app. */
fn watch_priorities(session: Arc<Session>, engine_state: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(RESTORE_TICK).await;
            let engine = engine_state.state::<Engine>();

            /* Two jobs in one loop, because they ask the same question two seconds apart and a
             * second timer would just wake the CPU twice for it. */
            service::set(downloading_summary(&session));

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
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
                    ..Default::default()
                },
            ))?;

            rescue_stranded_downloads(app, &downloads);

            app.manage(Engine {
                session: session.clone(),
                downloads,
                config_dir,
                folders: Mutex::new(HashMap::new()),
                wanted: Mutex::new(HashMap::new()),
                priority: Mutex::new(HashMap::new()),
            });
            watch_priorities(session, app.handle().clone());
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
            open_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running flai");
}
