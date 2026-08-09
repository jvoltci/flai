package com.jvoltci.flai

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    askForNotifications()
    askForStorage()
  }

  /**
   * The notification is not decoration — it is the permission slip.
   *
   * A foreground service is how a download survives leaving the app, and Android's bargain is
   * that such a service must show a notification saying so. Since Android 13 the user has to
   * grant that; refused, downloads still run and the status line is simply absent.
   */
  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
      == PackageManager.PERMISSION_GRANTED
    ) return
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
  }

  /**
   * All files access, so downloads land in the real Downloads folder.
   *
   * Every other route fails for this app. MediaStore and the Storage Access Framework both hand
   * out content:// URIs, and the torrent engine writes filesystem paths. The app-specific folder
   * under Android/data needs no permission at all — and on Android 11+ the Files app hides it,
   * so a finished download sits somewhere its owner cannot open. That was the bug this replaces.
   *
   * LibreTorrent, the reference open-source client, declares exactly this permission. It is
   * restricted on Play, which does not apply to a sideloaded app.
   *
   * Refusing is survivable: the Rust side falls back to the app folder, which still works, and
   * only the "where did it go" part gets worse. So this asks once and never nags.
   */
  private fun askForStorage() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    if (Environment.isExternalStorageManager()) return
    runCatching {
      startActivity(
        Intent(
          Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
          Uri.parse("package:$packageName")
        )
      )
    }.onFailure {
      // Some ROMs do not ship the per-app screen. The global list is the fallback.
      runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
    }
  }
}
