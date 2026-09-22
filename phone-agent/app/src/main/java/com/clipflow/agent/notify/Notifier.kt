package com.clipflow.agent.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * User-facing automation notifications.
 * Fail/block hone par KAARAN ke saath notification — user ko pata chale KYUN fail hui.
 */
object Notifier {

    const val CHANNEL_ID = "automation_status"
    private const val NOTIF_FAIL = 1001
    private const val NOTIF_BLOCK = 1002
    private const val NOTIF_DONE = 1003

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Automation status",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "AutoClip automation ke result — fail/block/success"
            }
        )
    }

    fun automationFailed(ctx: Context, reason: String?) {
        ensureChannel(ctx)
        val text = reason?.take(300) ?: "kaaran pata nahi chala — dashboard pe Jobs dekho"
        post(
            ctx, NOTIF_FAIL,
            "AutoClip automation FAIL hui",
            text,
            android.R.drawable.stat_notify_error
        )
    }

    fun automationBlocked(ctx: Context, reason: String?) {
        ensureChannel(ctx)
        val text = (reason?.take(300) ?: "Instagram ne action block kiya") +
            "\nDevice 24h ke liye auto-paused hai."
        post(
            ctx, NOTIF_BLOCK,
            "Instagram ne block kiya",
            text,
            android.R.drawable.stat_sys_warning
        )
    }

    fun automationSucceeded(ctx: Context, detail: String?) {
        ensureChannel(ctx)
        post(
            ctx, NOTIF_DONE,
            "AutoClip automation poori hui",
            detail?.take(200) ?: "Result dashboard pe bhej diya gaya.",
            android.R.drawable.stat_sys_upload_done
        )
    }

    private const val NOTIF_DISC = 1004
    private const val NOTIF_JOB = 1005
    // In-app auto-update (round-6 Worker D)
    private const val NOTIF_UPDATE_DL = 1006
    private const val NOTIF_UPDATE_REQ = 1007

    /**
     * p18 — real-time pickup: poll pe naya job milte hi user ko batao.
     * Automation turant start ho rahi hai — user ko wait nahi karana padta.
     */
    fun jobReceived(ctx: Context, jobType: String?) {
        ensureChannel(ctx)
        val type = jobType?.take(60)?.ifBlank { "automation" } ?: "automation"
        post(
            ctx, NOTIF_JOB,
            "⚡ Kaam mil gaya",
            "AutoClip ne naya kaam uthaya ($type) — automation abhi start ho rahi hai. " +
                "Progress Profile tab me dekho.",
            android.R.drawable.stat_sys_download
        )
    }

    /** Server ne device ko nahi pehchana (401) — user dobara connect kare. */
    fun deviceDisconnected(ctx: Context) {
        ensureChannel(ctx)
        post(
            ctx, NOTIF_DISC,
            "Device disconnected ho gaya",
            "Server ne is device ko nahi pehchana. App kholo → Profile me naya code daal ke dobara connect karo.",
            android.R.drawable.stat_notify_error
        )
    }

    // ---------- In-app auto-update (round-6 Worker D) ----------

    /** APK download progress (0..100). */
    fun updateProgress(ctx: Context, percent: Int) {
        try {
            ensureChannel(ctx)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("AutoClip update download ho raha hai")
                .setContentText("$percent%")
                .setProgress(100, percent.coerceIn(0, 100), false)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build()
            nm.notify(NOTIF_UPDATE_DL, n)
        } catch (_: Exception) { }
    }

    /** Download poora — installer khulne wala hai. */
    fun updateDownloaded(ctx: Context) {
        try {
            ensureChannel(ctx)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.cancel(NOTIF_UPDATE_DL)
            post(
                ctx, NOTIF_UPDATE_DL,
                "Update download ho gaya",
                "Install karne ke liye system dialog me \"Install\" dabao.",
                android.R.drawable.stat_sys_download_done
            )
        } catch (_: Exception) { }
    }

    /** Download fail — kaaran ke saath. */
    fun updateFailed(ctx: Context, reason: String?) {
        try {
            ensureChannel(ctx)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.cancel(NOTIF_UPDATE_DL)
            post(
                ctx, NOTIF_UPDATE_DL,
                "Update download nahi hua",
                (reason?.take(200) ?: "network issue") + " — app kholkar dobara try karo.",
                android.R.drawable.stat_notify_error
            )
        } catch (_: Exception) { }
    }

    /**
     * WP5: bg me update download ho gaya. "Naya update taiyaar hai, tap karo" —
     * tap → app khulti hai SEEDHA update popup pe (open_update=true).
     */
    fun updateReady(ctx: Context, versionName: String?) {
        ensureChannel(ctx)
        post(
            ctx, NOTIF_UPDATE_REQ,
            "Naya update taiyaar hai, tap karo",
            "Tap karte hi update popup khulega — install me sirf ek tap lagega.",
            android.R.drawable.stat_sys_download_done,
            openAppIntent(ctx, openUpdate = true)
        )
    }

    /** Force update aaya hai jab app background me thi — tap → seedha update popup. */
    fun forceUpdateRequired(ctx: Context, versionName: String?) {
        ensureChannel(ctx)
        post(
            ctx, NOTIF_UPDATE_REQ,
            "Zaroori update aaya hai",
            "AutoClip ka naya version ${versionName ?: ""} install karna LAZMI hai. " +
                "Tap karo — update popup khulega.",
            android.R.drawable.stat_sys_warning,
            openAppIntent(ctx, openUpdate = true)
        )
    }

    /**
     * Notification tap → MainActivity kholo. openUpdate=true →
     * MainActivity seedha update popup (UpdateActivity) pe redirect karti hai.
     */
    private fun openAppIntent(ctx: Context, openUpdate: Boolean = false): android.app.PendingIntent? {
        return try {
            val intent = android.content.Intent(
                ctx, Class.forName("com.clipflow.agent.MainActivity")
            ).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                if (openUpdate) putExtra("open_update", true)
            }
            android.app.PendingIntent.getActivity(
                ctx, if (openUpdate) 1 else 0, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or
                    android.app.PendingIntent.FLAG_IMMUTABLE
            )
        } catch (_: Exception) { null }
    }

    private fun post(
        ctx: Context, id: Int, title: String, text: String, icon: Int,
        contentIntent: android.app.PendingIntent? = null
    ) {
        try {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
            if (contentIntent != null) b.setContentIntent(contentIntent)
            nm.notify(id, b.build())
        } catch (_: Exception) {
            // notification permission nahi mili to chupchaap skip (crash nahi)
        }
    }
}
