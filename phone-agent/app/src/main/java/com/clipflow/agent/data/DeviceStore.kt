package com.clipflow.agent.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Device credentials ka store.
 *
 * p59 me EncryptedSharedPreferences tha (Tink-backed). Rebuild me wahi
 * wapas — lekin catch(Throwable) ke saath: Tink/AndroidKeyStore path pe
 * koi bhi missing class (NoClassDefFoundError = Error, Exception nahi)
 * aaye to plain prefs fallback, taaki app launch kabhi na atke
 * (BrowseAgent v6 se seekha hua lesson).
 *
 * api_key ek per-device bearer token hai (server pe sirf hash rehta hai).
 */
class DeviceStore(context: Context) {

    internal val prefs: SharedPreferences = run {
        val appCtx = context.applicationContext
        try {
            val masterKey = androidx.security.crypto.MasterKey.Builder(appCtx)
                .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
                .build()
            androidx.security.crypto.EncryptedSharedPreferences.create(
                appCtx,
                PREFS_NAME,
                masterKey,
                androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (t: Throwable) {
            // Tink/KeyStore missing ya koi bhi Error → plain fallback
            // (launch crash se bachna = sabse pehle).
            try {
                android.util.Log.w("DeviceStore", "ESP unavailable, plain prefs fallback: ${t.javaClass.simpleName}")
            } catch (_: Exception) {
            }
            appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    fun isEnrolled(): Boolean =
        prefs.contains(KEY_DEVICE_ID) && prefs.contains(KEY_API_KEY)

    fun save(deviceId: String, apiKey: String, serverUrl: String) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_API_KEY, apiKey)
            .putString(KEY_SERVER_URL, serverUrl.trimEnd('/'))
            .putBoolean(KEY_DISCONNECTED, false)
            .apply()
    }

    /**
     * Local unenroll (disconnect/delete ke baad): device_id + api_key hatao.
     * Server URL rehta hai taaki dobara enroll me pre-fill ho.
     */
    fun clearEnrollment() {
        prefs.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_API_KEY)
            .putBoolean(KEY_DISCONNECTED, false)
            .apply()
    }

    /**
     * Server ne 401 diya = device unknown/deleted/disconnected.
     * Is state me app "Disconnected" dikhata hai; Profile se dobara enroll ka rasta.
     */
    fun isDisconnected(): Boolean = prefs.getBoolean(KEY_DISCONNECTED, false)

    fun setDisconnected(d: Boolean) {
        prefs.edit().putBoolean(KEY_DISCONNECTED, d).apply()
    }

    fun deviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)
    fun apiKey(): String? = prefs.getString(KEY_API_KEY, null)
    fun serverUrl(): String =
        prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER) ?: DEFAULT_SERVER

    fun setServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER_URL, url.trimEnd('/')).apply()
    }

    /**
     * Completed-job guard: automation ek job_id ke liye sirf ek baar chalti hai.
     * Report fail ho to agli run me sirf re-report hota hai (dobara post NAHI).
     */
    fun markJobCompleted(jobId: String, resultJson: String) {
        prefs.edit().putString(KEY_COMPLETED_PREFIX + jobId, resultJson).apply()
    }

    fun getCompletedJob(jobId: String): String? =
        prefs.getString(KEY_COMPLETED_PREFIX + jobId, null)

    fun clearCompletedJob(jobId: String) {
        prefs.edit().remove(KEY_COMPLETED_PREFIX + jobId).apply()
    }

    /** Dashboard se aaya custom schedule (JSON) — boot/worker pe dobara lagta hai. */
    fun saveSchedule(json: String) {
        prefs.edit().putString(KEY_SCHEDULE, json).apply()
    }

    fun getSchedule(): String? = prefs.getString(KEY_SCHEDULE, null)

    /**
     * Aakhri kaamyab server contact (poll/heartbeat) ka waqt.
     * 0 = phone ne launch ke baad server ko kabhi touch hi nahi kiya.
     */
    fun lastSync(): Long = prefs.getLong(KEY_LAST_SYNC, 0L)

    fun setLastSync(ts: Long) {
        prefs.edit().putLong(KEY_LAST_SYNC, ts).apply()
    }

    /** Sleep mode: phone server ko poll NAHI karta, service/schedule band. */
    fun sleepMode(): Boolean = prefs.getBoolean(KEY_SLEEP_MODE, false)

    fun setSleepMode(sleep: Boolean) {
        prefs.edit().putBoolean(KEY_SLEEP_MODE, sleep).apply()
    }

    /**
     * Aakhri automation run ki info (Profile → Automation section ke liye).
     * Sirf real data — worker job start/complete pe likhta hai, poll bhi.
     * Shape: {job_id, status, time, kind} — kind = "automation" | "poll".
     */
    fun saveLastRun(jobId: String, status: String, time: Long, kind: String) {
        try {
            val j = org.json.JSONObject()
                .put("job_id", jobId)
                .put("status", status)
                .put("time", time)
                .put("kind", kind)
            prefs.edit().putString(KEY_LAST_RUN, j.toString()).apply()
        } catch (_: Exception) { }
    }

    fun getLastRun(): org.json.JSONObject? {
        return try {
            prefs.getString(KEY_LAST_RUN, null)?.let { org.json.JSONObject(it) }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * p18 — REAL-TIME POLL: har poll (job mile ya na mile) ka waqt.
     * Profile tab me "Poll: X sec pehle checked" dikhta hai taaki user ko
     * pata chale app zinda hai aur server se baat kar rahi hai.
     */
    fun setLastPollCheck(ts: Long) {
        prefs.edit().putLong(KEY_LAST_POLL_CHECK, ts).apply()
    }

    fun lastPollCheck(): Long = prefs.getLong(KEY_LAST_POLL_CHECK, 0L)

    /**
     * p18 — ACTIVE JOB: jo job abhi phone pe queued/running hai.
     * Shape: {job_id, type, status, received_at} — status = queued | running.
     * - Profile tab me "⚡ Kaam mil gaya" + type + progress dikhta hai.
     * - Doosra worker/poller dekh kar duplicate start NAHI karta (stale 30 min
     *   ke baad ignore — engine ka max timeout 25 min hai, uske baad worker
     *   mara hua maana jata hai).
     */
    fun setActiveJob(jobId: String, type: String, status: String) {
        try {
            // same job ka status update ho (running 3/24...) to received_at
            // WAHIN rahe — warna staleness check toot jayega
            val prev = getActiveJob()
            val receivedAt =
                if (prev != null && prev.optString("job_id") == jobId)
                    prev.optLong("received_at", System.currentTimeMillis())
                else System.currentTimeMillis()
            val j = org.json.JSONObject()
                .put("job_id", jobId)
                .put("type", type)
                .put("status", status)
                .put("received_at", receivedAt)
            prefs.edit().putString(KEY_ACTIVE_JOB, j.toString()).apply()
        } catch (_: Exception) { }
    }

    fun getActiveJob(): org.json.JSONObject? {
        return try {
            prefs.getString(KEY_ACTIVE_JOB, null)?.let { org.json.JSONObject(it) }
        } catch (_: Exception) {
            null
        }
    }

    fun clearActiveJob() {
        prefs.edit().remove(KEY_ACTIVE_JOB).apply()
    }

    /**
     * p18 — DUPLICATE ENQUEUE GUARD: fast poll (10s) + service poll (2 min) +
     * 15-min worker teeno alag-alag poll karte hain. Ek hi job ke liye dobara
     * one-time worker enqueue na ho, isliye aakhri enqueue ka record.
     * 5 min window ke andar same job_id → skip.
     */
    fun setLastQueuedJob(jobId: String, ts: Long) {
        try {
            val j = org.json.JSONObject().put("job_id", jobId).put("time", ts)
            prefs.edit().putString(KEY_LAST_QUEUED, j.toString()).apply()
        } catch (_: Exception) { }
    }

    fun getLastQueuedJob(): org.json.JSONObject? {
        return try {
            prefs.getString(KEY_LAST_QUEUED, null)?.let { org.json.JSONObject(it) }
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val DEFAULT_SERVER = "https://clipflow-webbuilder1.vercel.app"
        private const val PREFS_NAME = "device_prefs"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_COMPLETED_PREFIX = "completed_job_"
        private const val KEY_SCHEDULE = "schedule_json"
        private const val KEY_LAST_SYNC = "last_sync"
        private const val KEY_SLEEP_MODE = "sleep_mode"
        private const val KEY_DISCONNECTED = "disconnected"
        private const val KEY_LAST_RUN = "last_run"
        // p18: real-time pickup
        private const val KEY_LAST_POLL_CHECK = "last_poll_check"
        private const val KEY_ACTIVE_JOB = "active_job"
        private const val KEY_LAST_QUEUED = "last_queued_job"
        // Coin rewards (p13)
        private const val KEY_COIN_SEC = "coin_online_sec"
        private const val KEY_COIN_BAL = "coin_balance"
        private const val KEY_COIN_10M = "coin_10min_claimed"
        private const val KEY_COIN_2H = "coin_2h_claimed"
        private const val KEY_COIN_4H = "coin_4h_claimed"
        // In-app auto-update (round-6 Worker D)
        private const val KEY_UPDATE_CHECK = "update_last_check"
        private const val KEY_UPDATE_DISMISSED = "update_dismissed_code"
        // WP4 (2026-09-20): bg me download ho chuka update (install pending).
        private const val KEY_UPDATE_PENDING = "update_pending_json"
        // p43 (2026-09-21): USA proxy toggle + last verified region
        private const val KEY_USA_PROXY = "usa_proxy_enabled"
        private const val KEY_USA_PROXY_REGION = "usa_proxy_region"
        private const val KEY_USA_PROXY_TS = "usa_proxy_verified_at"
        // p54 (2026-09-21): manual-demo tap learning opt-in
        private const val KEY_LEARN_FROM_USER = "learn_from_user"
        // p53/p59: session sync snapshot (JSON)
        private const val KEY_SESSION_SYNC = "session_sync_json"
        // 2026-09-22 rebuild: user-imported apps (JSON [{package,label}])
        private const val KEY_IMPORTED_APPS = "imported_apps_json"
    }

    // ---------- In-app auto-update (round-6 Worker D) ----------

    /** Aakhri baar kab /api/app/version check hua (har ~6h). */
    fun lastUpdateCheck(): Long = prefs.getLong(KEY_UPDATE_CHECK, 0L)

    fun setLastUpdateCheck(ts: Long) {
        prefs.edit().putLong(KEY_UPDATE_CHECK, ts).apply()
    }

    /**
     * User ne "Baad me" dabakar kaunsa version_code dismiss kiya.
     * Us version ka dialog dobara nahi dikhega (naye version pe phir dikhega).
     */
    fun updateDismissedVersion(): Int = prefs.getInt(KEY_UPDATE_DISMISSED, 0)

    fun setUpdateDismissedVersion(v: Int) {
        prefs.edit().putInt(KEY_UPDATE_DISMISSED, v).apply()
    }

    /**
     * WP4: background me download ho chuka update (install pending).
     * {code, name, force} — file filesDir/updates/autoclip-update.apk me.
     * Install prompt SIRF idle state me dikhta hai (UpdateChecker.isIdle);
     * download kabhi run ko interrupt nahi karta.
     */
    fun setPendingUpdate(versionCode: Int, versionName: String, forceUpdate: Boolean) {
        try {
            val j = org.json.JSONObject()
                .put("code", versionCode)
                .put("name", versionName)
                .put("force", forceUpdate)
            prefs.edit().putString(KEY_UPDATE_PENDING, j.toString()).apply()
        } catch (_: Exception) { }
    }

    fun getPendingUpdate(): org.json.JSONObject? {
        return try {
            prefs.getString(KEY_UPDATE_PENDING, null)?.let { org.json.JSONObject(it) }
        } catch (_: Exception) { null }
    }

    fun clearPendingUpdate() {
        prefs.edit().remove(KEY_UPDATE_PENDING).apply()
    }

    // ---------- USA proxy (p43, 2026-09-21) ----------

    /**
     * USA proxy switch (Profile tab me dikhta hai). Default ON.
     * ON = whop.com/contentrewards.com ka traffic Vercel iad1 (Virginia, USA)
     * se nikalta hai; proxy fail ho to request BLOCK hoti hai (India IP leak
     * nahi hota — fail-closed). OFF = seedha direct (purana behavior).
     */
    fun usaProxyEnabled(): Boolean = prefs.getBoolean(KEY_USA_PROXY, true)

    fun setUsaProxyEnabled(v: Boolean) {
        prefs.edit().putBoolean(KEY_USA_PROXY, v).apply()
    }

    /** Aakhri kaamyab proxy response ka region (Vercel region code, e.g. iad1). */
    fun setUsaProxyVerified(region: String) {
        prefs.edit()
            .putString(KEY_USA_PROXY_REGION, region)
            .putLong(KEY_USA_PROXY_TS, System.currentTimeMillis())
            .apply()
    }

    fun usaProxyRegion(): String? = prefs.getString(KEY_USA_PROXY_REGION, null)

    fun usaProxyVerifiedAt(): Long = prefs.getLong(KEY_USA_PROXY_TS, 0L)

    // ---------- Coin rewards (p13) ----------

    /**
     * Kul online seconds (service tick se jama hota hai).
     * Reboot-safe: prefs me persist.
     */
    fun coinOnlineSec(): Long = prefs.getLong(KEY_COIN_SEC, 0L)

    fun addCoinOnlineSec(sec: Long) {
        if (sec <= 0) return
        prefs.edit().putLong(KEY_COIN_SEC, coinOnlineSec() + sec).apply()
    }

    fun coinBalance(): Long = prefs.getLong(KEY_COIN_BAL, 0L)

    fun addCoins(n: Long) {
        if (n <= 0) return
        prefs.edit().putLong(KEY_COIN_BAL, coinBalance() + n).apply()
    }

    /** 10-min target: SIRF EK BAAR claim ho sakta hai. */
    fun coin10MinClaimed(): Boolean = prefs.getBoolean(KEY_COIN_10M, false)

    fun setCoin10MinClaimed() {
        prefs.edit().putBoolean(KEY_COIN_10M, true).apply()
    }

    /** 2h/4h targets: kitne blocks claim ho chuke hain (unlimited). */
    fun coin2hClaimed(): Int = prefs.getInt(KEY_COIN_2H, 0)

    fun addCoin2hClaimed(n: Int) {
        if (n <= 0) return
        prefs.edit().putInt(KEY_COIN_2H, coin2hClaimed() + n).apply()
    }

    fun coin4hClaimed(): Int = prefs.getInt(KEY_COIN_4H, 0)

    fun addCoin4hClaimed(n: Int) {
        if (n <= 0) return
        prefs.edit().putInt(KEY_COIN_4H, coin4hClaimed() + n).apply()
    }

    // ---------- Manual-demo tap learning (p54) ----------

    /**
     * User ne tap-learning ke liye opt-in kiya? AutomationWorker isi se
     * decide karta hai ManualDemo.startRun(..., enabled) me.
     * Default: true (pehle run pe user ko bataya jata hai).
     */
    fun learnFromUser(): Boolean = prefs.getBoolean(KEY_LEARN_FROM_USER, true)

    fun setLearnFromUser(v: Boolean) {
        prefs.edit().putBoolean(KEY_LEARN_FROM_USER, v).apply()
    }

    // ---------- Session sync snapshot (p53/p59) ----------

    /** SessionSync.collectStatus() ka aakhri JSON snapshot. */
    fun sessionSyncJson(): String? = prefs.getString(KEY_SESSION_SYNC, null)

    fun saveSessionSyncJson(json: String) {
        prefs.edit().putString(KEY_SESSION_SYNC, json).apply()
    }

    // ---------- App import (2026-09-22 rebuild) ----------

    /** User ki chuni hui apps ka JSON snapshot. */
    fun importedAppsJson(): String? = prefs.getString(KEY_IMPORTED_APPS, null)

    fun saveImportedAppsJson(json: String) {
        prefs.edit().putString(KEY_IMPORTED_APPS, json).apply()
    }
}
