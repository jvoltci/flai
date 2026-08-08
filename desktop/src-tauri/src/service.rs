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

#[cfg(target_os = "android")]
mod imp {
    use anyhow::Result;
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    /// Calls a static method on DownloadService with the app Context as its first argument.
    fn call(method: &str, text: Option<&str>) -> Result<()> {
        // ndk-context is populated by the activity before any Rust runs, so this is safe to
        // reach for from any thread — including the background ticker, which is not the one
        // the JVM knows about, hence attach_current_thread.
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }?;
        let mut env = vm.attach_current_thread()?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let class = env.find_class("com/jvoltci/flai/DownloadService")?;

        match text {
            Some(t) => {
                let jtext = env.new_string(t)?;
                env.call_static_method(
                    class,
                    method,
                    "(Landroid/content/Context;Ljava/lang/String;)V",
                    &[JValue::Object(&context), JValue::Object(&jtext)],
                )?;
            }
            None => {
                env.call_static_method(
                    class,
                    method,
                    "(Landroid/content/Context;)V",
                    &[JValue::Object(&context)],
                )?;
            }
        }
        Ok(())
    }

    pub fn running(text: &str) {
        // A failure here means the notification is wrong, not that the download is. Log and
        // carry on rather than take the app down over a status line.
        if let Err(err) = call("start", Some(text)) {
            eprintln!("flai: could not start the foreground service: {err}");
        }
    }

    pub fn idle() {
        if let Err(err) = call("stop", None) {
            eprintln!("flai: could not stop the foreground service: {err}");
        }
    }

    /// getExternalFilesDir(null) — /sdcard/Android/data/<pkg>/files.
    ///
    /// Not the internal files/ directory Tauri's app_data_dir gives, because that one is
    /// invisible to every file manager without root: a download that finishes somewhere the
    /// user cannot reach has not really finished. Neither needs a storage permission.
    pub fn external_files_dir() -> Result<std::path::PathBuf> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }?;
        let mut env = vm.attach_current_thread()?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        let dir = env
            .call_method(
                &context,
                "getExternalFilesDir",
                "(Ljava/lang/String;)Ljava/io/File;",
                &[JValue::Object(&JObject::null())],
            )?
            .l()?;
        let path = env
            .call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[])?
            .l()?;
        let path: String = env.get_string((&path).into())?.into();
        Ok(std::path::PathBuf::from(path))
    }

    /// Hands a path to whatever app the user has for it.
    pub fn open_path(path: &str) -> Result<()> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }?;
        let mut env = vm.attach_current_thread()?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let class = env.find_class("com/jvoltci/flai/FileOpener")?;
        let jpath = env.new_string(path)?;
        env.call_static_method(
            class,
            "open",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(&context), JValue::Object(&jpath)],
        )?;
        Ok(())
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
