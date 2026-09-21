package com.clipflow.agent.engine

import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Job ka result + screenshots control plane ko bhejta hai.
 * POST /api/devices/jobs/:id/result (multipart)
 */
class Reporter(private val store: DeviceStore) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    data class JobResult(
        val status: String,          // succeeded | failed | blocked
        val vars: Map<String, String>,
        val error: String? = null,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("status", status)
            .put("vars", JSONObject(vars as Map<*, *>))
            .put("error", error)

        companion object {
            fun fromJson(o: JSONObject): JobResult = JobResult(
                status = o.optString("status", "failed"),
                vars = o.optJSONObject("vars")?.let { jo ->
                    jo.keys().asSequence().associateWith { jo.optString(it) }
                } ?: emptyMap(),
                error = o.optString("error").ifEmpty { null },
            )
        }
    }

    /** 400 = permanent (dobara bhejne se nahi sudhrega); baaki = transient. */
    class PermanentReportException(msg: String) : Exception(msg)

    /**
     * LIVE PREVIEW (2026-09-20 — user order):
     * Automation ke dauraan har 15 sec me WebView ka screenshot bhejta hai
     * taaki web dashboard (Live page) pe dikhe phone abhi kya kar raha hai.
     * POST /api/devices/:id/live-preview (multipart, shot=PNG)
     * Fail ho to chup-chaap ignore — preview critical path nahi hai.
     */
    fun uploadLivePreview(shot: File) {
        try {
            val server = store.serverUrl()
            val deviceId = store.deviceId() ?: return
            val apiKey = store.apiKey() ?: return
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("shot", "live.png", shot.asRequestBody("image/png".toMediaType()))
                .build()
            val req = Request.Builder()
                .url("$server/api/devices/$deviceId/live-preview")
                .header("X-Device-Id", deviceId)
                .header("X-Device-Key", apiKey)
                .post(body)
                .build()
            http.newCall(req).execute().use { /* ignore response */ }
        } catch (_: Exception) {
            // Preview fail = silent, automation nahi rukegi
        }
    }

    @Throws(Exception::class)
    fun report(jobId: String, result: JobResult, screenshots: List<File>) {
        val server = store.serverUrl()
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val apiKey = store.apiKey() ?: throw Exception("not enrolled")

        val meta = JSONObject()
            .put("status", result.status)
            .put("vars", JSONObject(result.vars as Map<*, *>))
        result.error?.let { meta.put("error", it) }

        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("device_id", deviceId)
            .addFormDataPart("meta", meta.toString())
        screenshots.forEachIndexed { i, f ->
            body.addFormDataPart(
                "shot_$i", f.name,
                f.asRequestBody("image/png".toMediaType())
            )
        }
        val req = Request.Builder()
            .url("$server/api/devices/jobs/$jobId/result")
            .header("X-Device-Id", deviceId)
            .header("X-Device-Key", apiKey)
            .post(body.build())
            .build()
        http.newCall(req).execute().use { resp ->
            if (resp.code == 400) throw PermanentReportException(
                "report rejected: ${resp.body?.string()?.take(200)}"
            )
            if (!resp.isSuccessful) throw Exception("report HTTP ${resp.code}")
        }
    }
}
