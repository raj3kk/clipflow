package com.clipflow.agent.work

import android.content.Context
import android.content.Intent
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.net.JobPoller
import com.clipflow.agent.notify.Notifier
import com.clipflow.agent.web.LoginState

/**
 * p18 — REAL-TIME JOB PICKUP ka shared rasta.
 *
 * POLLING CADENCE (kyun ye numbers):
 *  - FOREGROUND (app khuli hai, MainActivity): har 10 sec. App khuli hai to
 *    user active hai aur radio pehle se on hai — 10s ka chhota GET sasta hai,
 *    aur pickup latency ~10 sec rehti hai (user ko wait nahi karana padta).
 *  - BACKGROUND (RunnerService foreground service): har 2 min. Doze me thoda
 *    late ho sakta hai par service foreground hai + battery exemption maanga
 *    gaya hai, isliye kaafi reliable. 2 min = battery vs latency ka balance.
 *  - WorkManager 15-min periodic: aakhri backup (deep Doze, ya service kill).
 *    15 min WorkManager ka PLATFORM MINIMUM hai — isse tez nahi ho sakta.
 *  - FCM push (WakeService): sabse tez, par server-side setup pending hai —
 *    uske bina bhi upar wale 3 mil kar fast pickup dete hain.
 *  - 1-sec 24/7 polling JAAN-BOOJH KAR NAHI: battery khatm + server pe
 *    ~86,400 req/day/phone = seedha rate-limit/ban.
 *
 * Teeno poller (activity/service/worker) yahin se guzarte hain taaki:
 *  1. gate ek jagah check ho (enrolled + !sleep + !disconnected + dono login)
 *  2. ek hi job ke liye duplicate one-time worker enqueue na ho
 *     (DeviceStore.lastQueuedJob, 5-min window)
 *  3. "Kaam mil gaya" notification + Profile status ek jagah se update ho
 *
 * NOTE: ye blocking network karta hai — hamesha background thread se call karo.
 */
object JobPickup {

    /** Local broadcast: job state badli → MainActivity Profile refresh kare. */
    const val ACTION_JOB_STATE = "com.clipflow.agent.JOB_STATE_CHANGED"

    private const val DEDUPE_WINDOW_MS = 5 * 60_000L

    /** Automation gate — RunnerService/MainActivity dono yahi check karte hain. */
    fun gateOk(context: Context): Boolean {
        return try {
            val store = DeviceStore(context)
            store.isEnrolled() && !store.sleepMode() &&
                !store.isDisconnected() && LoginState.loginsOk()
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Ek poll cycle: gate → jobs/next → mila to turant start.
     * @return mila hua job, ya null (koi job nahi / gate band / network fail).
     * Har haal me lastPollCheck update hota hai taaki Profile me "app zinda
     * hai" dikhe. Failures silent hain — agla poll phir try karega.
     */
    fun pollAndStart(context: Context): JobPoller.Job? {
        val appCtx = context.applicationContext
        val store = DeviceStore(appCtx)
        if (!gateOk(appCtx)) return null
        return try {
            val job = JobPoller(store).nextJob()
            store.setLastPollCheck(System.currentTimeMillis())
            broadcastState(appCtx)
            if (job != null) {
                startAutomation(appCtx, job.id, job.type)
            }
            job
        } catch (_: Exception) {
            // network/server dikkat — silent; agla poll phir try karega
            try {
                store.setLastPollCheck(System.currentTimeMillis())
                broadcastState(appCtx)
            } catch (_: Exception) { }
            null
        }
    }

    /**
     * Job milte hi TURANT automation start: dedupe guard → active-job record →
     * one-time worker enqueue → "Kaam mil gaya" notification → broadcast.
     * Worker khud jobs/next dobara poll karke job uthata hai (server job ko
     * report hone tak hold karta hai).
     */
    fun startAutomation(context: Context, jobId: String, jobType: String) {
        val appCtx = context.applicationContext
        val store = DeviceStore(appCtx)
        // Dedupe: 5 min me same job dobara enqueue mat karo
        try {
            val lq = store.getLastQueuedJob()
            if (lq != null && lq.optString("job_id") == jobId &&
                System.currentTimeMillis() - lq.optLong("time", 0) < DEDUPE_WINDOW_MS
            ) {
                return
            }
        } catch (_: Exception) { }
        store.setLastQueuedJob(jobId, System.currentTimeMillis())
        store.setActiveJob(jobId, jobType, "queued")
        store.saveLastRun(jobId, "queued", System.currentTimeMillis(), "poll")
        try {
            Scheduler.ensureInitialized(appCtx)
            // pickup_job_id: worker ko pata chale use ISI job ke liye uthaya gaya
            // hai (duplicate-worker guard isko bypass karne deta hai)
            val data = androidx.work.workDataOf("pickup_job_id" to jobId)
            val req = OneTimeWorkRequestBuilder<AutomationWorker>()
                .setInputData(data)
                .addTag(AutomationWorker.TAG_AUTOMATION)
                .build()
            WorkManager.getInstance(appCtx).enqueue(req)
        } catch (_: Exception) {
            // enqueue fail → active job record rehta hai; agla poll phir try karega
        }
        try {
            Notifier.jobReceived(appCtx, jobType)
        } catch (_: Exception) { }
        broadcastState(appCtx)
    }

    /** Job khatm/fail/disconnect — active record saaf + UI ko batao. */
    fun clearJob(context: Context) {
        try {
            DeviceStore(context.applicationContext).clearActiveJob()
        } catch (_: Exception) { }
        broadcastState(context.applicationContext)
    }

    fun broadcastState(context: Context) {
        try {
            context.sendBroadcast(Intent(ACTION_JOB_STATE).setPackage(context.packageName))
        } catch (_: Exception) { }
    }
}
