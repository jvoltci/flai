package com.jvoltci.flai

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a finished download to whatever app the user already has.
 *
 * flai deliberately does not contain a video player. The content people actually download is
 * HEVC with EAC3 audio, which a WebView will not play, and building a real one means Media3
 * plus the FFmpeg extension — days of work to end up behind VLC. Handing the file over gets
 * every codec the device's hardware supports, and sidecar subtitles for free: a torrent ships
 * Movie.mkv next to Movie.en.srt, and every serious player loads a matching .srt by itself.
 */
object FileOpener {

    @JvmStatic
    fun open(context: Context, path: String) {
        val file = File(path)
        val target = if (file.isDirectory) file else file

        // A raw file:// URI throws FileUriExposedException on Android 7+. FileProvider hands
        // out a content:// URI instead, and the grant flag is what lets the other app read it.
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            target
        )

        val extension = MimeTypeMap.getFileExtensionFromUrl(path)?.lowercase()
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"

        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        // A chooser rather than the default, because "open with" is genuinely a choice here:
        // people have opinions about video players and the right one differs per file.
        val chooser = Intent.createChooser(view, "Open with").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }

    /**
     * Opens a still-downloading file, streamed from librqbit's server on localhost.
     *
     * No FileProvider here: there is no finished file to grant access to. The URL is plain http
     * on 127.0.0.1, and every Android video player can open one — VLC and MX Player both treat a
     * network stream exactly like a local file, seek bar included.
     *
     * A wildcard video type rather than a guess from the extension. ACTION_VIEW on an http URL
     * with no type is a browsing intent, and the browser answers it by downloading the file a
     * second time.
     */
    @JvmStatic
    fun openStream(context: Context, url: String) {
        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(url), "video/*")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val chooser = Intent.createChooser(view, "Play with").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }
}
