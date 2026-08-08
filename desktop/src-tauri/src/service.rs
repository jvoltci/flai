/* Telling Android that this process is busy.
 *
 * Android suspends an app the moment you leave it. A torrent takes hours, so without a
 * foreground service the Android build would stop downloading whenever you checked a message —
 * which would make it a demo rather than a downloader.
 *
 * The service is Kotlin (gen/android/.../DownloadService.kt) and owns nothing: the engine is
 * librqbit in this same process. Its whole job is to hold a notification up and say "the user
 * asked for this", which is the only way Android lets a process keep working in the background.
 *
 * Everything here is a no-op off Android, so the caller never has to care.
 */

/* ── why there is no JNI here ───────────────────────────────────────────────────
 *
 * The first version of this reached for `ndk_context::android_context()` to find the JavaVM
 * and the app Context, then called the Kotlin service over JNI. It aborted the process three
 * seconds after launch, every time:
 *
 *   thread '<unnamed>' panicked at ndk-context-0.1.1/src/lib.rs
 *   Fatal signal 6 (SIGABRT) in tid (Thread-2)
 *
 * ndk-context is a global that *something* has to populate — ndk-glue or android-activity do
 * it. Tauri does neither, and neither does wry; grepping both crates for `ndk_context` returns
 * nothing. So that call could never have worked here, and `panic = "abort"` in the release
 * profile means it cannot even be caught.
 *
 * The right way is a Tauri plugin, whose Kotlin half runs inside the activity and therefore
 * already has the Context, invoked from the frontend. That is a real piece of work and it is
 * not worth shipping a crashing app to get there sooner.
 *
 * Until then these are no-ops, and the consequences are honest ones: a download pauses when
 * Android suspends the app, and "Open" is not offered. Downloading itself is untouched.
 */
#[cfg(target_os = "android")]
mod imp {
    use anyhow::Result;

    pub fn running(_text: &str) {}
    pub fn idle() {}

    pub fn external_files_dir() -> Result<std::path::PathBuf> {
        anyhow::bail!("needs a Tauri plugin; see the note above")
    }

    pub fn open_path(_path: &str) -> Result<()> {
        anyhow::bail!("no player handoff yet — see the note above")
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use anyhow::Result;

    // A desktop keeps running when its window loses focus, so there is nothing to ask for.
    pub fn running(_text: &str) {}
    pub fn idle() {}

    pub fn external_files_dir() -> Result<std::path::PathBuf> {
        anyhow::bail!("android only")
    }

    /// Desktops have their own handler, wired through tauri-plugin-opener in the UI.
    pub fn open_path(_path: &str) -> Result<()> {
        anyhow::bail!("android only")
    }
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
    match &state {
        Some(text) => imp::running(text),
        None => imp::idle(),
    }
    *last = state;
}

/// Where downloads should go on this platform, when the platform has an opinion.
pub fn downloads_dir() -> Option<std::path::PathBuf> {
    imp::external_files_dir().ok().map(|d| d.join("downloads"))
}

/// Opens a finished download in another app. Android only; desktops use the opener plugin.
pub fn open(path: &str) -> anyhow::Result<()> {
    imp::open_path(path)
}
