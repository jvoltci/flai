package com.jvoltci.flai

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    askForNotifications()
  }

  /**
   * The notification is not decoration — it is the permission slip.
   *
   * A foreground service is how a download survives leaving the app, and Android's bargain is
   * that such a service must show a notification saying so. Since Android 13 the user has to
   * grant that, and if they do not the service still runs but silently, which means no progress,
   * no way back into the app, and nothing to explain why flai is using the network.
   *
   * Asked on launch rather than at the moment a download starts, because the alternative is a
   * permission dialog appearing over the thing the user just tapped.
   */
  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
    if (granted == PackageManager.PERMISSION_GRANTED) return
    // No result handling: if it is refused, downloads still work and the notification is simply
    // absent. Nagging on every launch would be worse than the missing status line.
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
  }
}
