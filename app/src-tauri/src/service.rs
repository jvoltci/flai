/* Telling Android that this process is busy, and handing files to other apps.
 *
 * Android suspends an app the moment you leave it. A torrent takes hours, so without a foreground
 * service the Android build stops downloading whenever you check a message — which makes it a
 * demo rather than a downloader.
 *
 * The Kotlin half is DownloadService and FileOpener, both in gen/android. Neither owns any
 * torrent state: the engine is librqbit in this same process, so the service's whole job is to
 * hold a notification up and say "the user asked for this", which is the only way Android lets a
 * process keep working in the background.
 *
 * Everything here is a no-op off Android, so the caller never has to care.
 */

/* ── why this is a plugin and not JNI ───────────────────────────────────────────
 *
 * The first version reached for `ndk_context::android_context()` to find the JavaVM and the app
 * Context. It aborted the process three seconds after launch, every time:
 *
 *   thread '<unnamed>' panicked at ndk-context-0.1.1/src/lib.rs
 *   Fatal signal 6 (SIGABRT) in tid (Thread-2)
 *
 * ndk-context is a global that *something* has to populate — ndk-glue or android-activity do it.
 * Tauri does neither, and neither does wry; grepping both crates for `ndk_context` returns
 * nothing. So that call could never have worked, and `panic = "abort"` in the release profile
 * means it could not even be caught.
 *
 * A Tauri plugin has no such problem. The PluginManager constructs the Kotlin class with the
 * Activity already in hand, so there is no Context to go hunting for, and run_mobile_plugin does
 * the JNI attach itself.
 */

#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::Wry;

#[cfg(target_os = "android")]
static BRIDGE: std::sync::OnceLock<tauri::plugin::PluginHandle<Wry>> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct BusyArgs<'a> {
    text: Option<&'a str>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct PathArgs<'a> {
    path: &'a str,
}

/// Registers the Kotlin side. A no-op plugin off Android, so `run()` can add it unconditionally.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("flai-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("com.jvoltci.flai", "FlaiPlugin")?;
                let _ = BRIDGE.set(handle);
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn push_busy(text: Option<&str>) {
    let Some(bridge) = BRIDGE.get() else { return };
    /* Deliberately swallowed. The notification is a courtesy; the download is the point, and
     * there is no log sink on a release Android build to report to anyway. The one failure that
     * matters — Android 12+ refusing a foreground service started from the background — is
     * already caught on the Kotlin side, where it is a normal outcome rather than an error. */
    let _ = bridge.run_mobile_plugin::<serde_json::Value>("setBusy", BusyArgs { text });
}

#[cfg(not(target_os = "android"))]
fn push_busy(_text: Option<&str>) {
    // A desktop keeps running when its window loses focus, so there is nothing to ask for.
}

/// Last state pushed, so the notification is only touched when the text actually changes.
/// Android coalesces repeat notifications anyway, but a JNI call every two seconds for six
/// hours is work nobody asked for.
static LAST: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// `Some(text)` while downloads are running, `None` when nothing is.
pub fn set(state: Option<String>) {
    let mut last = match LAST.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if *last == state {
        return;
    }
    push_busy(state.as_deref());
    *last = state;
}

/// Opens a finished download in another app. Android only; desktops use the opener plugin.
#[cfg(target_os = "android")]
pub fn open(path: &str) -> anyhow::Result<()> {
    let bridge = BRIDGE
        .get()
        .ok_or_else(|| anyhow::anyhow!("the Android bridge is not ready yet"))?;
    bridge
        .run_mobile_plugin::<serde_json::Value>("openPath", PathArgs { path })
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn open(_path: &str) -> anyhow::Result<()> {
    anyhow::bail!("android only")
}

// Hands a localhost stream URL to a video player.
//
// Separate from `open` because the intent has to declare a video MIME type: ACTION_VIEW on a
// bare http URL is a browsing intent, and the browser answers it by downloading the file again.
#[cfg(target_os = "android")]
pub fn open_stream(url: &str) -> anyhow::Result<()> {
    let bridge = BRIDGE
        .get()
        .ok_or_else(|| anyhow::anyhow!("the Android bridge is not ready yet"))?;
    bridge
        .run_mobile_plugin::<serde_json::Value>("openStream", PathArgs { path: url })
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}
