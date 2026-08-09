package com.jvoltci.flai

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps flai alive while downloads are running.
 *
 * Android suspends an app as soon as you leave it, and a torrent takes hours. Without this, a
 * 10 GB series stops the moment you check a message — which would make the Android build a toy.
 *
 * It deliberately owns no torrent state. The engine is librqbit, running in the Rust library in
 * this same process, so the only job here is to tell Android "this process is doing something
 * the user asked for, do not kill it", and to show the notification that makes that honest.
 *
 * The wake lock is partial: the CPU stays up, the screen does not.
 */
class DownloadService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        private const val CHANNEL_ID = "flai.downloads"
        private const val NOTIFICATION_ID = 1

        const val ACTION_START = "com.jvoltci.flai.START_DOWNLOADS"
        const val ACTION_STOP = "com.jvoltci.flai.STOP_DOWNLOADS"
        const val EXTRA_TEXT = "text"

        /** Called from Rust when the first download starts, and on every progress update. */
        @JvmStatic
        fun start(context: Context, text: String) {
            val intent = Intent(context, DownloadService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TEXT, text)
            }
            // startForegroundService requires startForeground() within ~5s or the app is killed
            // with a ForegroundServiceDidNotStartInTimeException. onStartCommand does it first.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Called from Rust when nothing is downloading any more. */
        @JvmStatic
        fun stop(context: Context) {
            context.startService(
                Intent(context, DownloadService::class.java).apply { action = ACTION_STOP }
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Downloading"
        startForeground(NOTIFICATION_ID, buildNotification(text))
        acquireWakeLock()

        /* START_STICKY, not START_NOT_STICKY: if Android kills the process under memory
         * pressure we want the service restarted, because librqbit's session is persisted and
         * the download can pick up where it left off. */
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun buildNotification(text: String): Notification {
        createChannel()

        // Tapping it reopens the app rather than starting a second copy of the activity.
        val tap = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle("flai")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        // LOW: it must be visible, because it is the reason the app may keep running, but a
        // download that runs for six hours must never make a sound.
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while flai is downloading, so Android does not stop it"
                setShowBadge(false)
            }
        )
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flai:downloads").apply {
            setReferenceCounted(false)
            // A bounded timeout, so a bug here can never hold the CPU awake for ever. The
            // service re-acquires on every progress update, which is well inside this.
            acquire(6 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }
}
