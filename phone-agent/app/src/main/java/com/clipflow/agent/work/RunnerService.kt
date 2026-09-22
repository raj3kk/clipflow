package com.clipflow.agent.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.app.Notification
import com.clipflow.agent.MainActivity
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.net.UpdateChecker
import com.clipflow.agent.web.LoginState
import org.json.JSONObject

/**
 * Foreground service — persistent notification dikhata hai
 * ("AutoClip active") taaki Android/OEM (Xiaomi/Oppo/Vivo)
 * app ko background me kill na kare.
 *
 * P2 me: yahin se WorkManager ka custom-interval schedule lagega.
 *
 * p13: Coin rewards ka "online time" ticker bhi yahin hai. Service TABHI
 * chalti hai jab device online hai (enrolled + !sleep + !disconnected +
 * Whop/IG login — automation gate), isliye tick ka chalna hi "online"
 * hone ka saboot hai. Har 60s pe elapsed time (cap 120s — Doze/delay me
 * dead period count nahi hota) DeviceStore me jama hota hai. Reboot-safe.
 *
 * p18 REAL-TIME PICKUP: service me 2-min ka job poll loop bhi hai.
 * Kyun 2 min: 1-sec 24/7 polling battery + server dono ko maar degi;
 * WorkManager ka 15-min platform minimum hai (isse tez nahi ho sakta);
 * app khuli ho to MainActivity ka 10-sec foreground poll sabse tez hai;
 * band app ke liye 2-min background poll + 15-min WorkManager backup +
 * FCM push (server setup pending) mil kar bina FCM ke bhi fast pickup dete hain.
 * Poll sirf automation gate khula ho tabhi (JobPickup.gateOk).
 */
class RunnerService : Service() {

    private var tickHandler: Handler? = null
    private var tickRunnable: Runnable? = null
    private var lastTickMs = 0L

    // p18: background job poll (2 min)
    private var pollHandler: Handler? = null
    private var pollRunnable: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Agent", NotificationManager.IMPORTANCE_LOW)
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("AutoClip • Online")
            .setContentText("Automation ke liye taiyaar")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        // saved custom schedule lagao (na ho to default 12h);
        // reboot ke baad bhi BootReceiver yahin se aata hai
        val store = DeviceStore(this)
        val saved = try {
            store.getSchedule()?.let { JSONObject(it) }
        } catch (_: Exception) { null }
        if (saved != null) {
            try {
                Scheduler.scheduleNext(this, saved)
            } catch (_: Exception) {
                Scheduler.schedule(this, 12)
            }
        } else {
            Scheduler.schedule(this, 12)
        }
        startCoinTicker()
        startJobPoll()
        return START_STICKY
    }

    override fun onDestroy() {
        stopCoinTicker()
        stopJobPoll()
        super.onDestroy()
    }

    /**
     * p18 — background job poll, har 2 min. Pehla poll turant.
     * Network blocking hai isliye alag thread pe; gate/dedupe/notify sab
     * JobPickup.pollAndStart me hai. Doze me Handler thoda late ho sakta hai —
     * isliye 15-min WorkManager poll backup ki tarah bana rehta hai.
     */
    private fun startJobPoll() {
        stopJobPoll()
        val h = Handler(Looper.getMainLooper())
        pollHandler = h
        val r = object : Runnable {
            override fun run() {
                Thread {
                    try {
                        JobPickup.pollAndStart(this@RunnerService)
                    } catch (_: Exception) { }
                }.apply { isDaemon = true }.start()
                pollHandler?.postDelayed(this, POLL_BG_MS)
            }
        }
        pollRunnable = r
        h.post(r)
    }

    private fun stopJobPoll() {
        try {
            pollRunnable?.let { pollHandler?.removeCallbacks(it) }
        } catch (_: Exception) {
        }
        pollRunnable = null
        pollHandler = null
    }

    /**
     * Coin ticker: har 60s pe "online" time jama karo.
     * Conditions har tick pe dobara check hoti hain (honest counting):
     * enrolled + sleep nahi + disconnected nahi + dono login.
     * Per-tick cap 120s: timer Doze me delay ho jaye to dead period
     * jama nahi hota — jhootha time kabhi nahi judta.
     */
    private fun startCoinTicker() {
        stopCoinTicker()
        val h = Handler(Looper.getMainLooper())
        tickHandler = h
        lastTickMs = System.currentTimeMillis()
        val r = object : Runnable {
            override fun run() {
                try {
                    coinTick()
                } catch (_: Exception) {
                }
                try {
                    updateTick()
                } catch (_: Exception) {
                }
                tickHandler?.postDelayed(this, 60_000)
            }
        }
        tickRunnable = r
        h.postDelayed(r, 60_000)
    }

    private fun stopCoinTicker() {
        try {
            tickRunnable?.let { tickHandler?.removeCallbacks(it) }
        } catch (_: Exception) {
        }
        tickRunnable = null
        tickHandler = null
    }

    private fun coinTick() {
        val now = System.currentTimeMillis()
        val elapsedSec = ((now - lastTickMs) / 1000).coerceIn(0, 120)
        lastTickMs = now
        if (elapsedSec <= 0) return
        val store = DeviceStore(this)
        if (!store.isEnrolled()) return
        if (store.sleepMode()) return
        if (store.isDisconnected()) return
        if (!LoginState.loginsOk()) return
        store.addCoinOnlineSec(elapsedSec)
    }

    /**
     * In-app auto-update (WP4 2026-09-20): 6h ABSOLUTE BACKSTOP.
     * Event-driven checks (app launch / FCM wake / job pickup / run complete)
     * primary hain; ye sirf tab chalta hai jab 6h me koi check na hua ho.
     * Naya release mile to bg me download + "app kholo" notification —
     * install prompt SIRF idle pe (UpdateChecker.handleReleaseAsync).
     */
    private fun updateTick() {
        Thread {
            try {
                val rel = UpdateChecker.checkIfBackstopDue(this) ?: return@Thread
                UpdateChecker.handleReleaseAsync(this, rel)
            } catch (_: Exception) { }
        }.apply { isDaemon = true }.start()
    }

    companion object {
        private const val CHANNEL_ID = "runner"
        private const val NOTIF_ID = 1
        /** p18: background poll cadence — 2 min (cadence ki wajah JobPickup me). */
        private const val POLL_BG_MS = 2 * 60_000L
    }
}
