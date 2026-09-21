package com.clipflow.agent.net

import android.content.Context
import android.util.Log
import com.clipflow.agent.data.DeviceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * P0 FIX (2026-09-19, round-6 Worker D):
 * Phone job claim karke execution ke dauraan koi heartbeat NAHI bhejta tha —
 * server 45 min tak andha rehta tha, job atki lagti thi.
 *
 * Ab AutomationWorker:
 *  - JobEngine ke HAR STEP pe heartbeat bhejta hai (step name ke saath).
 *  - Har ~45 sec me heartbeat (lambe wait wale steps ke beech bhi).
 *  - Body: {"step": "<current step label>"}.
 *  - Route already exists: POST /api/devices/jobs/[id]/heartbeat
 *    (device auth: X-Device-Id / X-Device-Key — ApiClient ka existing pattern).
 *
 * Failures SILENT hain (heartbeat fail != job fail); 3 consecutive fail pe
 * Log.w me ek line likhi jati hai (agale 3 pe phir).
 */
object JobHeartbeat {

    private const val TAG = "JobHeartbeat"

    /** Har ~45 sec me heartbeat — server ka stale-job window 45 min hai. */
    private const val INTERVAL_MS = 45_000L

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var loopJob: Job? = null

    @Volatile
    private var currentStep: String = "starting"

    @Volatile
    private var failStreak: Int = 0

    /**
     * WebView session signals ka provider (2026-09-20 WP3).
     * AutomationWorker ise AgentBrain.sessionSignals se jodta hai —
     * heartbeat body me {sessions:{ig, whop}} jata hai taaki server
     * devices.ig/whop_session_ok_at refresh kar sake. Null = purana
     * behavior (sirf step).
     */
    @Volatile
    var sessionProvider: (() -> Map<String, Boolean>)? = null

    /**
     * Job execution shuru: turant ek heartbeat (server ko abhi pata chale
     * job shuru hui) + har 45s ka loop. Pehle se koi loop chal raha ho to band.
     */
    @Synchronized
    fun start(ctx: Context, store: DeviceStore, jobId: String) {
        stop()
        currentStep = "starting"
        failStreak = 0
        val appCtx = ctx.applicationContext
        scope.launch { sendOnce(appCtx, store, jobId) }
        loopJob = scope.launch {
            while (isActive) {
                delay(INTERVAL_MS)
                sendOnce(appCtx, store, jobId)
            }
        }
    }

    /**
     * Har step pe AutomationWorker bulata hai: step label update + turant
     * heartbeat (45s wait nahi).
     */
    fun step(ctx: Context, store: DeviceStore, jobId: String, stepLabel: String) {
        currentStep = stepLabel.take(120)
        scope.launch {
            try {
                sendOnce(ctx.applicationContext, store, jobId)
            } catch (_: Exception) {
                // sendOnce khud silent hai; ye double-guard hai
            }
        }
    }

    /** Job khatam/fail/timeout: loop band karo. */
    @Synchronized
    fun stop() {
        try {
            loopJob?.cancel()
        } catch (_: Exception) {
        }
        loopJob = null
    }

    private suspend fun sendOnce(ctx: Context, store: DeviceStore, jobId: String) {
        try {
            val sessions = try {
                sessionProvider?.invoke()?.let { m ->
                    org.json.JSONObject().apply {
                        put("ig", m["ig"] == true)
                        put("whop", m["whop"] == true)
                    }
                }
            } catch (_: Exception) { null }
            ApiClient.postHeartbeat(store, jobId, currentStep, sessions).also { resp ->
                // WP4 piggyback: run ke dauraan naya release aaya to bg me
                // download karo. Run ACTIVE hai → handleReleaseAsync sirf
                // download karega, install prompt kabhi nahi (interrupt nahi).
                try {
                    val rel = resp.optJSONObject("app_update")
                        ?.let { UpdateChecker.parseRelease(it) }
                    if (rel != null && rel.isNewerThanInstalled()) {
                        UpdateChecker.handleReleaseAsync(ctx, rel)
                    }
                } catch (_: Exception) { }
            }
            failStreak = 0
        } catch (e: Exception) {
            // silent: heartbeat fail hone se job NAHI rukti, retry NAHI hota
            failStreak++
            if (failStreak >= 3) {
                Log.w(TAG, "heartbeat 3 baar lagatar fail (job $jobId): ${e.message}")
                failStreak = 0 // agale 3 fail pe phir log hoga
            }
        }
    }
}
