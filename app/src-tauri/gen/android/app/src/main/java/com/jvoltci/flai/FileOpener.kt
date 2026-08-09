package com.jvoltci.flai

import android.content.Context
import android.content.Intent
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
}
