package com.clipflow.agent.net

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Server se agla job uthata hai (long-poll).
 * Cap (4 per 2 days) server-side enforce hota hai — yahan koi cap logic nahi.
 */
class JobPoller(private val deviceStore: com.clipflow.agent.data.DeviceStore) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS) // long-poll
        .build()

    data class Job(
        val id: String,
        val type: String,
        val payload: JSONObject,
        /** WP4 piggyback: server ne poll response me latest release bheja (null = nahi bheja). */
        val appUpdate: UpdateChecker.Release? = null
    )

    /** Common headers — X-App-Version se server ko pata chalta hai phone pe kaun sa APK hai. */
    private fun baseBuilder(): Request.Builder {
        return Request.Builder()
            .header("X-Device-Key", deviceStore.apiKey() ?: throw Exception("not enrolled"))
            .header("X-Device-Id", deviceStore.deviceId() ?: throw Exception("not enrolled"))
            .header("X-App-Version", com.clipflow.agent.BuildConfig.VERSION_NAME)
    }

    /** null = koi job nahi */
    @Throws(Exception::class)
    fun nextJob(): Job? {
        val req = baseBuilder()
            .url(deviceStore.serverUrl() + "/api/devices/jobs/next")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            if (resp.code == 204) return null
            val text = resp.body?.string().orEmpty()
            val json = JSONObject(text)
            if (!resp.isSuccessful) {
                throw ApiException(resp.code, json.optString("error", "poll HTTP ${resp.code}"))
            }
            if (!json.optBoolean("has_job", false)) return null
            val appUpd = json.optJSONObject("app_update")?.let { UpdateChecker.parseRelease(it) }
            return Job(
                id = json.getString("job_id"),
                type = json.optString("type", "custom"),
                payload = json.getJSONObject("payload"),
                appUpdate = appUpd
            )
        }
    }

    /**
     * Server se custom schedule uthata hai. Koi bhi dikkat → null
     * (schedule optional hai; purana schedule chalta rahega).
     */
    fun fetchSchedule(): JSONObject? {
        return try {
            val req = baseBuilder()
                .url(deviceStore.serverUrl() + "/api/devices/me/schedule")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val json = JSONObject(resp.body?.string().orEmpty())
                json.optJSONObject("schedule")
            }
        } catch (_: Exception) {
            null
        }
    }
}
