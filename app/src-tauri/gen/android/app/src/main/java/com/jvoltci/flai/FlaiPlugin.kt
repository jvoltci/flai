package com.jvoltci.flai

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/* The one thing Rust could not do for itself.
 *
 * DownloadService and FileOpener were written long before this file and never ran, because
 * nothing could call them. The first attempt went through JNI with ndk-context, which aborts the
 * process on launch: ndk-context is a global that ndk-glue or android-activity populates, and
 * Tauri uses neither — grep both crates for `ndk_context` and you get nothing.
 *
 * A Tauri plugin is the supported route precisely because it sidesteps that problem. The class is
 * constructed by the PluginManager with the Activity already in hand, so there is no Context to
 * go looking for. Rust reaches it through PluginHandle::run_mobile_plugin, which does the JNI
 * attach itself.
 *
 * It stays a thin bridge on purpose: no torrent state, no decisions. The engine is librqbit in
 * this same process, and everything here is one line of "tell Android".
 */

@InvokeArg
class BusyArgs {
    /** The notification line, or null when nothing is downloading any more. */
    var text: String? = null
}

@InvokeArg
class PathArgs {
    lateinit var path: String
}

@TauriPlugin
class FlaiPlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Raise or drop the foreground service.
     *
     * Called on every progress tick, but Rust only calls through when the text actually changed,
     * so this is a handful of calls per download rather than one every two seconds.
     */
    @Command
    fun setBusy(invoke: Invoke) {
        val text = invoke.parseArgs(BusyArgs::class.java).text
        /* Android 12 forbids starting a foreground service from the background, and throws
         * ForegroundServiceStartNotAllowedException when you try. In practice a download starts
         * because somebody tapped a button, so the app is in front and this is allowed — but a
         * session restored on launch, or a queued torrent starting late, can land here from
         * behind. Failing to raise a notification must not take the download down with it. */
        runCatching {
            if (text == null) DownloadService.stop(activity) else DownloadService.start(activity, text)
        }
        invoke.resolve()
    }

    /** Hand a finished file to whatever player the user already has. */
    @Command
    fun openPath(invoke: Invoke) {
        val path = invoke.parseArgs(PathArgs::class.java).path
        runCatching { FileOpener.open(activity, path) }
            .onSuccess { invoke.resolve() }
            .onFailure { invoke.reject(it.message ?: "nothing on this device opens that file") }
    }

    /**
     * Hand a still-downloading file to a player, as a URL.
     *
     * Deliberately not the same call as openPath. A content:// URI is for a file that exists;
     * this one points at librqbit's own server on localhost, which fills in the pieces as the
     * player asks for them. The MIME type is the part that matters: ACTION_VIEW on a bare http
     * URL goes to the browser, which downloads it. Declaring a wildcard video type is what puts
     * VLC and MX Player in the chooser instead.
     */
    @Command
    fun openStream(invoke: Invoke) {
        val url = invoke.parseArgs(PathArgs::class.java).path
        runCatching { FileOpener.openStream(activity, url) }
            .onSuccess { invoke.resolve() }
            .onFailure { invoke.reject(it.message ?: "no video player is installed") }
    }
}
