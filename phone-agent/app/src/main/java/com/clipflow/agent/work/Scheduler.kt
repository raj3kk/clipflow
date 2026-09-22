package com.clipflow.agent.work

import android.content.Context
import androidx.work.Configuration
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Custom schedule (dashboard se): interval ya fixed times-of-day.
 * Default 12h (MAX 4 automations / 2 days cap server-side enforce hota hai).
 *
 * WorkManager LAZY init: manifest ka auto-init hataya gaya hai taaki app
 * launch pe kabhi na atke. Pehli scheduling pe init hota hai, fail ho to
 * false (caller ya UI ko pata chalta hai, crash nahi hota).
 */
object Scheduler {

    private const val UNIQUE_NAME = "automation"
    private const val UNIQUE_ONCE_NAME = "automation-once"

    /** WorkManager taiyaar karo. False = is phone pe init fail (app phir bhi chalegi). */
    fun ensureInitialized(context: Context): Boolean {
        return try {
            try {
                WorkManager.getInstance(context)
            } catch (_: IllegalStateException) {
                WorkManager.initialize(
                    context.applicationContext,
                    Configuration.Builder().build()
                )
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Naya model (v0.1.0-p5): phone har 15 min me server ko halka poll karta hai.
     * Schedule ka matlab ab "server kab job banayega" hai — server tick har
     * 15 min me due slots pe khud job banata hai, phone poll pe utha leta hai.
     * FCM ho to Run Now turant; nahi to agle poll pe (max ~15 min).
     * intervalHours param ab sirf backward-compat ke liye hai (timing fix 15 min).
     */
    fun schedule(context: Context, intervalHours: Long = 12): Boolean {
        if (!ensureInitialized(context)) return false
        return try {
            val req = PeriodicWorkRequestBuilder<AutomationWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .addTag(AutomationWorker.TAG_AUTOMATION)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                req
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Server schedule JSON lagao. Phone-side timing ab hamesha 15-min poll hai;
     * schedule (mode/times/enabled) server tick pe lagu hota hai.
     * Purana times-mode one-time chain hata diya jata hai (migration).
     * Kabhi crash nahi.
     */
    fun scheduleNext(context: Context, schedule: JSONObject): Boolean {
        if (!ensureInitialized(context)) return false
        return try {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_ONCE_NAME)
            schedule(context, 12)
        } catch (_: Exception) {
            false
        }
    }

    fun cancel(context: Context) {
        try {
            if (!ensureInitialized(context)) return
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_ONCE_NAME)
        } catch (_: Exception) { }
    }
}
