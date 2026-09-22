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
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentLinkedQueue

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
     * p70 (2026-09-22): step-event history. Har step start / step fail pe
     * event enqueue hota hai ({t, step, phase, msg, ok}); sendOnce me drain
     * karke heartbeat body me `events` (max 20/call) jata hai — server
     * inhe device_jobs.live_steps me likhta hai. Pehle heartbeat me sirf
     * current step label jata tha, timeout/fail jobs me koi step history
     * nahi milti thi.
     */
    private val events = ConcurrentLinkedQueue<JSONObject>()

    /**
     * p70: WebView ka downscaled live frame dene wala provider. AutomationWorker
     * ise engine.webViewFrameB64() se jodta hai (360px JPEG q60 → base64).
     * Null = purana behavior (koi frame nahi). Screenshot main thread pe
     * chahiye — provider khud withContext(Dispatchers.Main) karta hai.
     */
    @Volatile
    var frameProvider: (suspend () -> String?)? = null

    /** p70: frame throttle — 20 sec me max 1 frame (heartbeat har step pe hota hai). */
    private const val FRAME_THROTTLE_MS = 20_000L

    @Volatile
    private var lastFrameAt: Long = 0L

    private fun utcNow(): String = SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US
    ).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())

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
        events.clear() // p70: pichle job ke events kabhi leak na hon
        lastFrameAt = 0L
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
     * Har step pe AutomationWorker bulata hai: step label update + step-start
     * event queue me + turant heartbeat (45s wait nahi).
     */
    fun step(ctx: Context, store: DeviceStore, jobId: String, stepLabel: String) {
        currentStep = stepLabel.take(120)
        enqueueEvent(stepLabel.take(120), "start", true, null)
        scope.launch {
            try {
                sendOnce(ctx.applicationContext, store, jobId)
            } catch (_: Exception) {
                // sendOnce khud silent hai; ye double-guard hai
            }
        }
    }

    /**
     * p70: step END event — AutomationWorker ke onStepEnd se (fail pe
     * {phase:"end", ok:false, msg}). Server live_steps me likhta hai taaki
     * step fail turant diagnosable ho.
     */
    fun event(
        ctx: Context,
        store: DeviceStore,
        jobId: String,
        stepLabel: String,
        phase: String,
        ok: Boolean,
        msg: String? = null,
    ) {
        enqueueEvent(stepLabel.take(120), phase, ok, msg?.take(120))
        scope.launch {
            try {
                sendOnce(ctx.applicationContext, store, jobId)
            } catch (_: Exception) {
            }
        }
    }

    private fun enqueueEvent(stepLabel: String, phase: String, ok: Boolean, msg: String?) {
        try {
            val o = JSONObject()
                .put("t", utcNow())
                .put("step", stepLabel)
                .put("phase", phase)
                .put("ok", ok)
            if (!msg.isNullOrEmpty()) o.put("msg", msg)
            events.offer(o)
            // queue bound: purane events bahar (server ko max 20/call milte hain)
            while (events.size > 100) events.poll()
        } catch (_: Exception) { }
    }

    /** Drain queued events — max 20/call (server contract). Null = koi event nahi. */
    private fun drainEvents(): JSONArray? {
        val list = ArrayList<JSONObject>(20)
        var e = events.poll()
        while (e != null && list.size < 20) {
            list.add(e)
            e = events.poll()
        }
        return if (list.isEmpty()) null else JSONArray(list)
    }

    /** Throttled live frame: 20 sec me max 1. Null = abhi nahi / provider nahi / fail. */
    private suspend fun captureFrame(): String? {
        val provider = frameProvider ?: return null
        val now = System.currentTimeMillis()
        if (now - lastFrameAt < FRAME_THROTTLE_MS) return null
        lastFrameAt = now
        return try {
            provider()
        } catch (_: Throwable) {
            null
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
        // p70: events pehle drain karo; POST fail ho to wapas queue me
        // (evidence khoye bina) taaki agle heartbeat me jayein
        val evArr = drainEvents()
        val frame = captureFrame()
        try {
            val sessions = try {
                sessionProvider?.invoke()?.let { m ->
                    org.json.JSONObject().apply {
                        put("ig", m["ig"] == true)
                        put("whop", m["whop"] == true)
                    }
                }
            } catch (_: Exception) { null }
            ApiClient.postHeartbeat(
                store, jobId, currentStep, sessions, evArr, frame
            ).also { resp ->
                // p53 (2026-09-21, user order): automation ke dauraan KOI update
                // check/download nahi — piggyback skip. Run khatm hone ke baad
                // AutomationWorker-finally check pakdega; update sirf tab jab
                // automation band (idle) ho.
                if (!UpdateChecker.isIdle(ctx)) return@also
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
            // silent: heartbeat fail hone se job NAHI rukti, retry NAHI hota —
            // lekin drained events wapas queue me taaki agle heartbeat me jayein
            try {
                evArr?.let { arr ->
                    for (i in 0 until arr.length()) events.offer(arr.getJSONObject(i))
                    while (events.size > 100) events.poll()
                }
            } catch (_: Exception) { }
            failStreak++
            if (failStreak >= 3) {
                Log.w(TAG, "heartbeat 3 baar lagatar fail (job $jobId): ${e.message}")
                failStreak = 0 // agale 3 fail pe phir log hoga
            }
        }
    }
}
