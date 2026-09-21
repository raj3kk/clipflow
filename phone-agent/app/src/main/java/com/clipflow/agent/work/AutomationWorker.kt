package com.clipflow.agent.work

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.DisplayMetrics
import android.view.View
import android.webkit.WebView
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.engine.AgentBrain
import com.clipflow.agent.engine.JobEngine
import com.clipflow.agent.engine.Reporter
import com.clipflow.agent.net.JobPoller
import com.clipflow.agent.net.JobHeartbeat
import com.clipflow.agent.net.UpdateChecker
import com.clipflow.agent.notify.Notifier
import com.clipflow.agent.web.LoginWebView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Poora automation cycle:
 *   jobs/next poll → hidden WebView me JobEngine.run → result + screenshots report.
 *
 * EXACTLY-ONCE GUARD: ek job_id ki automation sirf ek baar chalti hai.
 * Report fail ho (ya phone reboot ho) to agli run me sirf re-report hota hai —
 * dobara Instagram post NAHI hota. Isliye report-failure pe Result.retry()
 * NAHI karte (retry poori automation dobara chalata = duplicate post).
 *
 * NOTE: WebView application-context pe banta hai (background worker se).
 * Kuch OEMs pe Activity-context zyada stable hota hai — real device test (P1)
 * me verify hoga; dikkat aayi to AutomationActivity (transparent) fallback hai.
 */
class AutomationWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val appCtx = applicationContext
        val store = DeviceStore(appCtx)
        if (!store.isEnrolled()) return Result.success()

        // Foreground service: lamba automation run (10+ min) — OS/WorkManager ka
        // 10-minute background kill nahi lagega. Notification user ko dikhti hai.
        try {
            Notifier.ensureChannel(appCtx)
            val n = androidx.core.app.NotificationCompat.Builder(appCtx, Notifier.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("AutoClip automation chal rahi hai")
                .setContentText("Instagram upload + Whop submit…")
                .setOngoing(true)
                .build()
            val fi = if (android.os.Build.VERSION.SDK_INT >= 29) {
                androidx.work.ForegroundInfo(1001, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                @Suppress("DEPRECATION") androidx.work.ForegroundInfo(1001, n)
            }
            setForeground(fi)
        } catch (_: Exception) {
            // foreground na mil paye to bhi kaam jari rakho (best-effort)
        }

        // dashboard ka custom schedule lagao (fail → saved schedule, phir purana)
        try {
            val sched = withContext(Dispatchers.IO) { JobPoller(store).fetchSchedule() }
                ?: store.getSchedule()?.let { JSONObject(it) }
            sched?.let {
                store.saveSchedule(it.toString())
                Scheduler.scheduleNext(appCtx, it)
            }
        } catch (_: Exception) { }

        return try {
            val job = withContext(Dispatchers.IO) { JobPoller(store).nextJob() }
                ?: return Result.success() // koi kaam nahi

            // WP4 (2026-09-20): FORCE_UPDATE = FAIL-CLOSED — run START se pehle.
            // Server force_update:true + installed purana → NAYA run mat chalao
            // (stale brain naye jobs pe nahi chalega). Piggybacked release
            // prefer karo (poll response se — extra network call nahi), warna
            // fresh check. Current run abhi start nahi hua → interrupt ka
            // sawaal hi nahi: update bg me download karo, "app kholo" bolo,
            // job server queue me rehne do (update ke baad uth jayegi).
            val gateRel = try {
                job.appUpdate ?: withContext(Dispatchers.IO) { UpdateChecker.checkNow(appCtx) }
            } catch (_: Exception) { null }
            if (gateRel != null && gateRel.isNewerThanInstalled() && gateRel.forceUpdate) {
                try {
                    withContext(Dispatchers.IO) {
                        val f = UpdateChecker.downloadRelease(appCtx, gateRel, silent = true) { pct ->
                            Notifier.updateProgress(appCtx, pct)
                        }
                        if (f != null) {
                            store.setPendingUpdate(gateRel.versionCode, gateRel.versionName, true)
                            Notifier.forceUpdateRequired(appCtx, gateRel.versionName)
                        }
                        // Claim wapas chhodo taaki update ke baad job turant uth
                        // sake. "blocked" report NAHI — wo 24h auto-pause lagata.
                        try {
                            com.clipflow.agent.net.ApiClient.releaseJob(store, job.id)
                        } catch (_: Exception) { }
                    }
                } catch (_: Exception) { }
                try { JobPickup.clearJob(appCtx) } catch (_: Exception) { }
                return Result.success()
            }

            val shotsDir = File(File(appCtx.filesDir, "jobs"), "shots").apply { mkdirs() }

            // --- re-report path: automation pehle ho chuki, sirf report dobara ---
            val completedJson = store.getCompletedJob(job.id)
            if (completedJson != null) {
                val result = Reporter.JobResult.fromJson(JSONObject(completedJson))
                val shots = shotsDir.listFiles { f -> f.extension == "png" }?.toList() ?: emptyList()
                tryReport(store, job.id, result, shots)
                JobPickup.clearJob(appCtx) // purane crash ka stale active record saaf
                return Result.success()
            }

            // p18 DUPLICATE-WORKER GUARD: fast poll (10s) + service poll (2 min) +
            // 15-min worker teeno poll karte hain. Koi aur worker isi job pe kaam
            // kar raha ho to dobara mat chalao (duplicate IG post ka khatra).
            // pickup_job_id wala worker (JobPickup ne ISI job ke liye uthaya) ko chhoot.
            // 30 min se purana active record = mara hua worker, ignore karo.
            val claimedByPickup = inputData.getString("pickup_job_id") == job.id
            val active = store.getActiveJob()
            val activeAgeMs = active?.optLong("received_at", 0L)
                ?.let { System.currentTimeMillis() - it } ?: Long.MAX_VALUE
            val activeClaimed = active != null && active.optString("job_id") == job.id &&
                activeAgeMs < 30 * 60_000L && (
                active.optString("status").startsWith("running") ||
                    (active.optString("status") == "queued" && activeAgeMs < 5 * 60_000L)
                )
            if (activeClaimed && !claimedByPickup) {
                return Result.success() // doosra worker sambhal raha hai
            }
            store.setActiveJob(job.id, job.type, "running")
            JobPickup.broadcastState(appCtx)
            // P0 HEARTBEAT (2026-09-19): execution ke dauraan server ko har
            // step pe + har 45s me "zinda hoon" batao — warna server 45 min
            // tak andha rehta hai aur job atki lagti hai.
            // WP3 (2026-09-20): heartbeat me WebView session signals bhi
            // jate hain — server devices.ig/whop_session_ok_at refresh karta
            // hai (upload/submit se pehle brain freshness verify karta hai).
            JobHeartbeat.sessionProvider = { AgentBrain.sessionSignals() }
            JobHeartbeat.start(appCtx, store, job.id)
            store.saveLastRun(job.id, "running", System.currentTimeMillis(), "automation")

            var wvRef: WebView? = null
            // p39-knowledge: memory-sync se `knowledge.*` lessons (server push,
            // bina APK ke) — content: {id/rule_id, title/rule_title, text/rule_text,
            // skill/skill_key}. Bundled asset ke upar merge honge.
            var knowledgeUpdatesJson: String? = null
            // p39: job start pe server brain se semantic lessons pull karo —
            // pichle runs ka seekha hua gyaan (skill_lesson + semantic memory).
            // Best-effort: fail ho to job bina lessons ke chalega.
            val serverLessons: String? = withContext(Dispatchers.IO) {
                try {
                    val skillKeys = when (job.type) {
                        "join_campaign" -> listOf("campaign-scout", "compliance-guard")
                        "verify_campaigns" -> listOf("campaign-scout")
                        "discover_campaigns" -> listOf("campaign-scout")
                        else -> listOf(
                            "compliance-guard", "render-director",
                            "upload-coordinator", "submit-verifier"
                        )
                    }
                    val resp = com.clipflow.agent.net.ApiClient.syncMemory(
                        store,
                        JSONObject()
                            .put("direction", "pull")
                            .put("skill_keys", org.json.JSONArray(skillKeys))
                    )
                    val arr = resp.optJSONArray("lessons") ?: return@withContext null
                    if (arr.length() == 0) return@withContext null
                    // knowledge.* lessons alag nikalo (server knowledge push)
                    try {
                        val rules = org.json.JSONArray()
                        for (i in 0 until arr.length()) {
                            val l = arr.optJSONObject(i) ?: continue
                            if (!l.optString("key", "").startsWith("knowledge.")) continue
                            val c = l.optJSONObject("content") ?: continue
                            val id = c.optString("id").ifEmpty { c.optString("rule_id") }
                            if (id.isEmpty()) continue
                            rules.put(
                                JSONObject()
                                    .put("id", id)
                                    .put("title", c.optString("title").ifEmpty { c.optString("rule_title") })
                                    .put("text", c.optString("text").ifEmpty { c.optString("rule_text") })
                            )
                        }
                        if (rules.length() > 0) {
                            knowledgeUpdatesJson = JSONObject()
                                .put("version", "server-push")
                                .put("rules", rules).toString()
                        }
                    } catch (_: Exception) { }
                    buildString {
                        for (i in 0 until minOf(arr.length(), 8)) {
                            val l = arr.optJSONObject(i) ?: continue
                            val key = l.optString("key", "?")
                            // content object ya truncated string dono ho sakta hai
                            val content = l.optJSONObject("content")?.toString()
                                ?: l.optString("content", "")
                            append("• ").append(key).append(": ")
                                .append(content.take(180)).append('\n')
                        }
                    }.take(1500)
                } catch (_: Exception) { null }
            }
            // Round-7 (Worker A): step start (onStep) + step end (onStepEnd)
            // dono pe progress + server heartbeat — step fail turant dikhe.
            fun pushProgress(stepLabel: String) {
                try {
                    store.setActiveJob(job.id, job.type, "running $stepLabel")
                    JobPickup.broadcastState(appCtx)
                } catch (_: Exception) { }
                try {
                    JobHeartbeat.step(appCtx, store, job.id, stepLabel)
                } catch (_: Exception) { }
            }
            // p39: phone brain terminal fail → server pe agent_issue file karo
            // (escalation pipeline — assistant root-cause fix karega). IO pe
            // fire-and-forget; job flow kabhi nahi rokega.
            val brainFailedHook: (String, String) -> Unit = { label, detail ->
                kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                    try {
                        com.clipflow.agent.net.ApiClient.fileAgentIssue(
                            store,
                            "medium",
                            "Phone brain terminal failure: $label",
                            JSONObject()
                                .put("job_id", job.id)
                                .put("job_type", job.type)
                                .put("detail", detail.take(500)),
                            "phone AgentBrain $label pe terminal FAILED — trail Live page pe; server brain decide karega"
                        )
                    } catch (_: Exception) { }
                }
            }
            val engine = withContext(Dispatchers.Main) {
                // P1 FIX (2026-09-19): job specs (IG "Create", "Select from computer",
                // Whop submit steps) DESKTOP-web DOM pe likhe hain. Default mobile UA
                // pe Instagram mobile layout deta hai jisme ye text kabhi nahi aata —
                // isliye 9b116a4b step 6/37 pe "wait_text timeout: Create" se fail hui.
                // Fix: automation WebView ko desktop Chrome UA + density 1.0
                // (CSS px = device px 1:1) + 1920x1080 layout — IG/Whop full desktop
                // layout serve karte hain, spec ke saare text milte hain.
                // WebView hidden hai, isliye landscape se user ko farak nahi padta.
                // Login wali VISIBLE WebView (MainActivity) mobile hi rehti hai.
                // Cookies CookieManager me app-wide shared hain — login bana rehta hai.
                val desktopCtx = object : ContextWrapper(appCtx) {
                    private var fixedRes: Resources? = null
                    override fun getResources(): Resources {
                        fixedRes?.let { return it }
                        val base = super.getResources()
                        val m = DisplayMetrics().apply {
                            setTo(base.displayMetrics)
                            density = 1.0f
                            scaledDensity = 1.0f
                            densityDpi = DisplayMetrics.DENSITY_MEDIUM
                        }
                        return Resources(
                            base.assets, m, Configuration(base.configuration)
                        ).also { fixedRes = it }
                    }
                }
                val wv = WebView(desktopCtx)
                LoginWebView.setup(wv)
                wv.settings.userAgentString =
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                        "AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/126.0.0.0 Safari/537.36"
                // hidden lekin laid-out (1920x1080, density 1:1) taaki screenshot
                // draw() kaam kare aur desktop layout mile
                wv.measure(
                    View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY)
                )
                wv.layout(0, 0, 1920, 1080)
                wvRef = wv
                JobEngine(
                    context = appCtx,
                    webView = wv,
                    workDir = File(appCtx.filesDir, "jobs").apply { mkdirs() },
                    onStep = { idx, total, action ->
                        // p18: har step pe Profile tab me live progress
                        pushProgress("step ${idx + 1}/$total ($action)")
                    },
                    onStepEnd = { idx, total, action, ok, error ->
                        // Round-7: step khatam (success ya fail) — Live page +
                        // server heartbeat pe turant dikhe
                        val mark = if (ok) "✓" else "✗"
                        val detail = if (!ok && !error.isNullOrBlank())
                            ": ${error.take(80)}" else ""
                        pushProgress("step ${idx + 1}/$total ($action) $mark$detail")
                    },
                    // LIVE PREVIEW (2026-09-20): web Live page pe phone ki screen dikhe
                    reporter = Reporter(store),
                    // p39: two-brain coordination — server lessons + escalation hook
                    serverLessons = serverLessons,
                    onBrainFailed = brainFailedHook,
                    // p39-knowledge: server knowledge push (bina APK ke updates)
                    serverKnowledgeUpdates = knowledgeUpdatesJson,
                )
            }

            // p18 STALL SAFETY: engine ke andar 20-min step deadline hai; uske
            // upar 25-min ka backstop. supervisorScope taaki timeout ki
            // cancellation worker ke baaki kaam (report!) ko na maare.
            // Round-7: join_campaign jobs dedicated handler chalate hain
            // (Whop campaign page pe Join tap — engine.runJoinCampaign).
            // Round-7b: verify_campaigns jobs dedicated handler chalate hain
            // (Whop pe candidates check + best-fit choose — engine.runVerifyCampaigns).
            val res: JobEngine.RunResult = try {
                supervisorScope {
                    withTimeout(25 * 60_000L) {
                        when (job.type) {
                            "join_campaign" -> engine.runJoinCampaign(job.payload)
                            "verify_campaigns" -> engine.runVerifyCampaigns(job.payload)
                            "discover_campaigns" -> engine.runDiscoverCampaigns(job.payload)
                            else -> engine.run(job.payload)
                        }
                    }
                }
            } catch (e: TimeoutCancellationException) {
                JobEngine.RunResult(
                    false, emptyMap(), emptyList(),
                    "job timeout (25 min) — beech me atak gaya tha, fail-mark kiya gaya"
                )
            }
            var errText = res.error
            val status = when {
                engine.rendererCrashed -> {
                    errText = "WebView renderer crash — job fail-mark ki gayi"
                    "failed"
                }
                res.ok -> "succeeded"
                isBlocked(res.error) -> "blocked"
                else -> "failed"
            }
            var shots = res.screenshots
            // LOCKED RULE: succeeded bina screenshot proof ke nahi —
            // engine ne koi shot na liya ho to fallback capture.
            if (status == "succeeded" && shots.isEmpty()) {
                fallbackShot(wvRef, shotsDir)?.let { shots = listOf(it) }
            }
            val result = Reporter.JobResult(status, res.vars, errText)

            // pehle local record (reboot-safe), phir report
            store.markJobCompleted(job.id, result.toJson().toString())
            store.saveLastRun(job.id, status, System.currentTimeMillis(), "automation")
            tryReport(store, job.id, result, shots)

            // p39: episodic outcome → server shared memory. Server brain +
            // trainer isse skill lessons banayenge. Best-effort, fire-and-forget.
            kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                try {
                    val outcome = JSONObject()
                        .put("job_type", job.type)
                        .put("status", status)
                        .put("error", (errText ?: "").take(300))
                    // brain ke nateeje (join/verify/discover) — chhota rakho
                    for (k in listOf(
                        "join_status", "join_detail", "verify_status",
                        "verify_detail", "discover_status", "brain_goal"
                    )) {
                        res.vars[k]?.let { outcome.put(k, it.take(200)) }
                    }
                    com.clipflow.agent.net.ApiClient.syncMemory(
                        store,
                        JSONObject()
                            .put("direction", "push")
                            .put("kind", "episodic")
                            .put("key", "job:${job.id}")
                            .put("content", outcome)
                            .put("importance", if (status == "succeeded") 0.6 else 0.8)
                    )
                } catch (_: Exception) { }
            }

            // USER NOTIFICATION: fail/block ka kaaran user ko dikhe
            when (status) {
                "blocked" -> Notifier.automationBlocked(appCtx, res.error)
                "failed" -> Notifier.automationFailed(appCtx, res.error)
                else -> Notifier.automationSucceeded(
                    appCtx,
                    when (job.type) {
                        "join_campaign" ->
                            "Whop campaign join ho gaya: ${res.vars["join_detail"] ?: ""}"
                        "verify_campaigns" ->
                            "Campaign verify ho gaya: ${res.vars["verify_detail"] ?: ""}"
                        "discover_campaigns" ->
                            "Naye campaigns mile: ${res.vars["discover_detail"] ?: ""}"
                        else -> res.vars["reel_url"]?.let { "Reel post ho gaya: $it" }
                    }
                )
            }

            LoginWebView.flushCookies()
            JobPickup.clearJob(appCtx)
            Result.success()
        } catch (e: com.clipflow.agent.net.ApiException) {
            // 401 = server ne device ko nahi pehchana (deleted/disconnected).
            // Dobara poll ka koi fayda nahi — user ko batao, automation roko.
            if (e.code == 401) {
                store.setDisconnected(true)
                try { Scheduler.cancel(appCtx) } catch (_: Exception) { }
                try {
                    appCtx.stopService(
                        android.content.Intent(appCtx, RunnerService::class.java)
                    )
                } catch (_: Exception) { }
                store.saveLastRun("poll", "disconnected-401", System.currentTimeMillis(), "poll")
                JobPickup.clearJob(appCtx)
                Notifier.deviceDisconnected(appCtx)
                return Result.success()
            }
            Result.retry()
        } catch (e: Exception) {
            // poll/engine me dikkat → WorkManager retry (automation abhi chali nahi)
            JobPickup.clearJob(appCtx)
            Result.retry()
        } finally {
            // P0: job khatam/fail/timeout/retry — heartbeat loop hamesha band
            try {
                JobHeartbeat.stop()
            } catch (_: Exception) { }
            // WP4 (2026-09-20): run COMPLETE hone ke baad event-driven update
            // check. Active job upar clear ho chuka (success paths) → idle pe
            // install prompt ka rasta khulta hai; retry paths pe active record
            // rehta hai → sirf bg download, interrupt kabhi nahi. 15-min
            // min-gap duplicate-storm rokta hai.
            try {
                val rel = withContext(Dispatchers.IO) { UpdateChecker.checkForEvent(appCtx) }
                if (rel != null) UpdateChecker.handleReleaseAsync(appCtx, rel)
            } catch (_: Exception) { }
        }
    }

    /**
     * Report bhejo. Permanent 400 → record saaf (dobara koi fayda nahi).
     * Transient failure → Round-7 (Worker A): 3 attempts EXPONENTIAL BACKOFF
     * ke saath (5s, 15s) — turant-turant retry se network blip nahi sudharta.
     * Teenon fail → record REHTA HAI (agli run re-report karegi),
     * lekin Result.success() (poori automation retry NAHI = no duplicate post).
     */
    private suspend fun tryReport(
        store: DeviceStore,
        jobId: String,
        result: Reporter.JobResult,
        shots: List<File>
    ) = withContext(Dispatchers.IO) {
        val backoffs = longArrayOf(5_000L, 15_000L)
        var attempt = 0
        while (true) {
            try {
                Reporter(store).report(jobId, result, shots)
                store.clearCompletedJob(jobId)
                return@withContext
            } catch (e: Reporter.PermanentReportException) {
                store.clearCompletedJob(jobId) // 400: server ne mana kiya, aage badho
                return@withContext
            } catch (e: Exception) {
                if (attempt >= backoffs.size) return@withContext // record rehta hai; agli run retry
                try {
                    delay(backoffs[attempt])
                } catch (_: Exception) { }
                attempt++
            }
        }
    }

    private suspend fun fallbackShot(wv: WebView?, dir: File): File? =
        withContext(Dispatchers.Main) {
            try {
                val w = wv ?: return@withContext null
                val bmp = Bitmap.createBitmap(1080, 1920, Bitmap.Config.ARGB_8888)
                w.draw(Canvas(bmp))
                val f = File(dir, "fallback_${System.currentTimeMillis()}.png")
                FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 90, it) }
                f
            } catch (_: Exception) {
                null
            }
        }

    private fun isBlocked(error: String?): Boolean {
        if (error == null) return false
        val e = error.lowercase()
        return e.contains("try again later") ||
            e.contains("action blocked") ||
            e.contains("restrict") ||
            e.contains("suspicious")
    }

    companion object {
        const val TAG_AUTOMATION = "automation"
    }
}
