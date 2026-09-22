package com.clipflow.agent.net

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.clipflow.agent.BuildConfig
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.notify.Notifier
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * AutoClip in-app auto-update (round-6 Worker D; WP4 2026-09-20 automation-first).
 *
 * Flow:
 *  1. checkNow(): GET /api/app/version (public, no login) -> latest release.
 *     server_code > BuildConfig.VERSION_CODE ho to naya update hai.
 *  2. downloadRelease(): OkHttp se APK background me download + progress notification.
 *  3. installRelease(): FileProvider URI + ACTION_VIEW (package installer prompt).
 *     Android 8+: canRequestPackageInstalls() false ho to user ko ek baar
 *     Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES pe bhejo (Hinglish guide ke saath).
 *
 * WP4 EVENT-DRIVEN CHECKS (fixed 6h timer nahi — wo sirf absolute backstop hai):
 *  - app launch (MainActivity)
 *  - FCM wake receive (WakeService)
 *  - job pickup/claim (AutomationWorker, run start se pehle)
 *  - run complete hone ke baad (AutomationWorker finally)
 *  - piggyback: jobs/next + heartbeat responses me `app_update` field
 *  Duplicate-storm se bachne ke liye 15-min min-gap (DeviceStore.lastUpdateCheck).
 *
 * RUN KO KABHI INTERRUPT NAHI: run ke dauraan naya release mile to bg me
 * download hota hai, install prompt SIRF idle pe (koi active job nahi).
 *
 * FORCE_UPDATE = FAIL-CLOSED: server force_update:true + installed purana →
 * NAYA run start nahi hota (stale brain naye jobs pe nahi chalega). Current
 * run finish hota hai, phir "app kholo — update taiyaar hai" notification.
 *
 * IMAANDAAR LIMIT: system install dialog ka ek "Install" tap Android me
 * hatega nahi — silent zero-tap install sirf system/pre-installed apps kar
 * sakti hain. Automation-first ka matlab: check+download proactive ho taaki
 * user ke liye sirf wahi ek tap bache, aur stale brain kabhi automation na chalaye.
 */
object UpdateChecker {

    const val VERSION_URL = "https://clipflow-webbuilder1.vercel.app/api/app/version"

    /** Absolute backstop: 6h me kam se kam ek check (RunnerService tick). */
    const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

    /** Event-driven checks ke beech min gap — duplicate-storm protection. */
    const val EVENT_MIN_GAP_MS = 15 * 60_000L

    data class Release(
        val versionCode: Int,
        val versionName: String,
        val apkUrl: String,
        val changelog: String,
        val forceUpdate: Boolean
    ) {
        /** Kya ye release installed version se nayi hai? */
        fun isNewerThanInstalled(): Boolean = versionCode > BuildConfig.VERSION_CODE
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .addInterceptor(UsEgressInterceptor({ UsEgressInterceptor.sharedStore })) // p63 layer 3
        .build()

    /**
     * Server se latest release lao. Koi release nahi / network error /
     * parse error -> null (caller chupchaap skip kare, user ko pareshan nahi).
     * Har attempt pe lastUpdateCheck update hota hai taaki event min-gap
     * aur 6h backstop cadence bani rahe.
     */
    fun checkNow(ctx: Context): Release? {
        val store = DeviceStore(ctx)
        try {
            val req = Request.Builder().url(VERSION_URL).get().build()
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (resp.code == 404 || text.isBlank()) return null
                if (!resp.isSuccessful) return null
                return parseRelease(JSONObject(text))
            }
        } catch (_: Exception) {
            return null
        } finally {
            try { store.setLastUpdateCheck(System.currentTimeMillis()) } catch (_: Exception) { }
        }
    }

    /**
     * JSONObject -> Release (null-safe). jobs/next + heartbeat ke
     * `app_update` piggyback field ko bhi yahi parse karta hai.
     */
    fun parseRelease(obj: JSONObject): Release? {
        return try {
            val code = obj.optInt("version_code", 0)
            val url = obj.optString("apk_url", "")
            if (code <= 0 || !url.startsWith("https://")) return null
            Release(
                versionCode = code,
                versionName = obj.optString("version_name", "v$code"),
                apkUrl = url,
                changelog = obj.optString("changelog", ""),
                forceUpdate = obj.optBoolean("force_update", false)
            )
        } catch (_: Exception) { null }
    }

    /**
     * WP4: event-driven check (app launch / FCM wake / job pickup / run complete).
     * 6h gate HATA DIYA — sirf 15-min min-gap (duplicate-storm protection).
     */
    fun checkForEvent(ctx: Context): Release? {
        val store = DeviceStore(ctx)
        val last = try { store.lastUpdateCheck() } catch (_: Exception) { 0L }
        if (System.currentTimeMillis() - last < EVENT_MIN_GAP_MS) return null
        return checkNow(ctx)
    }

    /**
     * 6h ABSOLUTE BACKSTOP (RunnerService tick se). Event-driven checks ke
     * alawa agar 6h me koi check na hua ho to ek check pakka hota hai.
     */
    fun checkIfBackstopDue(ctx: Context): Release? {
        val store = DeviceStore(ctx)
        val last = try { store.lastUpdateCheck() } catch (_: Exception) { 0L }
        if (System.currentTimeMillis() - last < CHECK_INTERVAL_MS) return null
        return checkNow(ctx)
    }

    /**
     * APK download karo: <filesDir>/updates/autoclip-update.apk.
     * Progress 0..100 Notifier.updateProgress() se dikhta hai.
     * @param silent true = "download ho gaya, Install dabao" notification mat
     *   dikhao (bg orchestrator khud "app kholo" notification dikhata hai —
     *   system installer prompt bg se kabhi nahi khulta).
     * @return downloaded file, ya null (fail).
     */
    fun downloadRelease(
        ctx: Context,
        release: Release,
        silent: Boolean = false,
        onProgress: (Int) -> Unit
    ): File? {
        val appCtx = ctx.applicationContext
        return try {
            Notifier.updateProgress(appCtx, 0)
            val dir = File(appCtx.filesDir, "updates").apply { mkdirs() }
            val out = pendingApkFile(appCtx)
            val req = Request.Builder().url(release.apkUrl).get().build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
                val body = resp.body ?: throw Exception("empty body")
                val total = body.contentLength()
                var done = 0L
                var lastPct = -1
                body.byteStream().use { input ->
                    out.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            done += n
                            if (total > 0) {
                                val pct = ((done * 100) / total).toInt().coerceIn(0, 100)
                                if (pct != lastPct) {
                                    lastPct = pct
                                    onProgress(pct)
                                }
                            }
                        }
                    }
                }
            }
            if (out.length() < 100_000) {
                // itni chhoti file APK nahi ho sakti — corrupt/HTML page
                try { out.delete() } catch (_: Exception) { }
                throw Exception("downloaded file too small (${out.length()} bytes)")
            }
            onProgress(100)
            if (!silent) Notifier.updateDownloaded(appCtx)
            out
        } catch (e: Exception) {
            Notifier.updateFailed(appCtx, e.message)
            null
        }
    }

    /** Downloaded update APK ka fixed path (DeviceStore pending record ke saath). */
    fun pendingApkFile(ctx: Context): File =
        File(File(ctx.applicationContext.filesDir, "updates"), "autoclip-update.apk")

    /**
     * Kya abhi install prompt dikhana SAFE hai? Active (fresh, running) job
     * ho to false — run ko kabhi interrupt nahi karna.
     */
    fun isIdle(ctx: Context): Boolean {
        return try {
            val active = DeviceStore(ctx).getActiveJob() ?: return true
            val ageMs = System.currentTimeMillis() - active.optLong("received_at", 0L)
            val running = active.optString("status").startsWith("running") && ageMs < 30 * 60_000L
            !running
        } catch (_: Exception) { true }
    }

    /**
     * WP4 background orchestrator — bg thread pe chalao (khud thread banata hai).
     *
     * - release installed se nayi nahi → pending saaf, kuch nahi.
     * - nayi hai → background me download karo (run active ho tab bhi —
     *   download run ko touch nahi karta), pending record set karo.
     * - notification: force → "Zaroori update" / warna "update taiyaar hai —
     *   app kholo". SYSTEM INSTALL PROMPT yahan kabhi nahi khulta; wo sirf
     *   MainActivity me idle state pe (promptInstallIfPending).
     * - same version pehle se downloaded + notified → dobara kuch nahi
     *   (45s heartbeat piggyback repeat se bachne ke liye).
     */
    fun handleReleaseAsync(ctx: Context, rel: Release) {
        val appCtx = ctx.applicationContext
        Thread {
            try {
                val store = DeviceStore(appCtx)
                if (!rel.isNewerThanInstalled()) {
                    try { store.clearPendingUpdate() } catch (_: Exception) { }
                    return@Thread
                }
                val pend = try { store.getPendingUpdate() } catch (_: Exception) { null }
                val file = pendingApkFile(appCtx)
                val alreadyHave = pend?.optInt("code", 0) == rel.versionCode &&
                    file.exists() && file.length() > 100_000
                if (alreadyHave) return@Thread // pehle hi download + notify ho chuka
                val dl = downloadRelease(appCtx, rel, silent = true) { pct ->
                    Notifier.updateProgress(appCtx, pct)
                } ?: return@Thread // fail notification downloadRelease ne dikha di
                store.setPendingUpdate(rel.versionCode, rel.versionName, rel.forceUpdate)
                if (rel.forceUpdate) {
                    Notifier.forceUpdateRequired(appCtx, rel.versionName)
                } else {
                    Notifier.updateReady(appCtx, rel.versionName)
                }
            } catch (_: Exception) { }
        }.apply { isDaemon = true }.start()
    }

    /**
     * System package installer kholo. Pehle "unknown apps" permission check:
     * Android 8+ pe canRequestPackageInstalls() false ho to false return —
     * caller Hinglish guide dikhakar Settings pe le jaye.
     * @return true = installer khul gaya, false = permission chahiye.
     */
    fun installRelease(ctx: Context, apkFile: File): Boolean {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                if (!ctx.packageManager.canRequestPackageInstalls()) return false
            } catch (_: Exception) { }
        }
        val uri: Uri = try {
            FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", apkFile)
        } catch (_: Exception) {
            return false
        }
        return try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * WP5: kya system installer abhi khul sakta hai? (Android 8+ "unknown apps"
     * permission — ek baar ka system step.) false = pehle Hinglish guide.
     */
    fun canInstallPackages(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 26) return true
        return try {
            ctx.packageManager.canRequestPackageInstalls()
        } catch (_: Exception) { false }
    }

    /** "Unknown apps install karne do" wali system settings kholo (ek baar ka step). */
    fun openUnknownAppSourcesSettings(ctx: Context) {        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${ctx.packageName}")
            ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            ctx.startActivity(intent)
        } catch (_: Exception) {
            try {
                ctx.startActivity(
                    Intent(Settings.ACTION_SECURITY_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) { }
        }
    }

    @Suppress("unused")
    fun legacyDownloadManagerNote(): String =
        "DownloadManager use nahi kiya — OkHttp codebase me pehle se hai aur " +
            "progress callback seedha milta hai."
}
