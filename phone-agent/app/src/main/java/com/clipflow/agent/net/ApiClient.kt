package com.clipflow.agent.net

import com.clipflow.agent.BuildConfig
import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** HTTP code ke saath throw hone wala API error (401 = device unknown/deleted). */
class ApiException(val code: Int, message: String) : Exception(message)

/**
 * Control plane (AutoClip server) se baat karne wala client.
 * P0 me sirf enroll. P2 me jobs poll / heartbeat / result judenge.
 * p11: disconnect (unenroll) + delete (soft-delete) calls.
 */
object ApiClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    data class EnrollResult(val deviceId: String, val apiKey: String)

    @Throws(Exception::class)
    fun enroll(serverUrl: String, code: String): EnrollResult {
        val json = JSONObject().put("code", code.trim())
        val body = json.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url(serverUrl.trimEnd('/') + "/api/devices/enroll")
            .post(body)
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (!resp.isSuccessful) {
                throw Exception(json.optString("error", "Enroll failed (HTTP ${resp.code})"))
            }
            return EnrollResult(
                deviceId = json.getString("device_id"),
                apiKey = json.getString("api_key")
            )
        }
    }

    /** Device-auth headers — jobs/next wale hi headers. */
    private fun authBuilder(store: DeviceStore): Request.Builder {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val apiKey = store.apiKey() ?: throw Exception("not enrolled")
        return Request.Builder()
            .header("X-Device-Id", deviceId)
            .header("X-Device-Key", apiKey)
            .header("X-App-Version", BuildConfig.VERSION_NAME)
    }

    /**
     * POST /api/devices/{id}/disconnect → server ko unenroll batao.
     * 401 = server pehle se device ko nahi janta (phir bhi local clear karna chahiye).
     */
    @Throws(Exception::class)
    fun disconnect(store: DeviceStore): JSONObject {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val body = "{}".toRequestBody("application/json".toMediaType())
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId/disconnect")
            .post(body)
            .build()
        return deviceCall(req)
    }

    /**
     * DELETE /api/devices/{id} → soft delete (7 din restore window).
     */
    @Throws(Exception::class)
    fun deleteDevice(store: DeviceStore): JSONObject {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId")
            .delete()
            .build()
        return deviceCall(req)
    }

    /** POST /api/devices/{id}/restore → soft-deleted device wapas lao. */
    @Throws(Exception::class)
    fun restoreDevice(store: DeviceStore): JSONObject {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val body = "{}".toRequestBody("application/json".toMediaType())
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId/restore")
            .post(body)
            .build()
        return deviceCall(req)
    }

    /**
     * GET /api/devices/me/earnings → Earn tab.
     * Contract: {ok, submissions:[{id, campaign_slug, campaign_name, reel_url,
     * whop_status, submitted_at, views, estimated_earnings_usd}], totals:{...}}.
     * views/earnings null ho sakte hain — UI "—" dikhata hai, fake number kabhi nahi.
     */
    @Throws(Exception::class)
    fun getEarnings(store: DeviceStore): JSONObject {
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/me/earnings")
            .get()
            .build()
        return deviceCall(req)
    }

    /**
     * P0 (2026-09-19, round-6 Worker D): job execution heartbeat.
     * POST /api/devices/jobs/{id}/heartbeat, body {"step": "<label>"}.
     * Route device auth (X-Device-Id / X-Device-Key) se verify karta hai.
     * Failures caller (JobHeartbeat) me silent handle hoti hain.
     */
    @Throws(Exception::class)
    fun postHeartbeat(store: DeviceStore, jobId: String, step: String, sessions: JSONObject? = null): JSONObject {
        val bodyObj = JSONObject().put("step", step)
        if (sessions != null) bodyObj.put("sessions", sessions)
        val body = bodyObj.toString()
            .toRequestBody("application/json".toMediaType())
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/jobs/$jobId/heartbeat")
            .post(body)
            .build()
        return deviceCall(req)
    }

    /**
     * WP4: force_update gate ne claimed job ko run nahi hone diya →
     * claim wapas chhodo (status='queued'). Best-effort: fail ho to server
     * ka stale-job reaper (10/45 min) sambhal lega.
     */
    fun releaseJob(store: DeviceStore, jobId: String): JSONObject {
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/jobs/$jobId/release")
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    /**
     * p39: agent memory sync — server brain ke saath shared memory.
     * POST /api/agent/memory/sync (device auth).
     * body: {"direction":"pull","skill_keys":[...]} → {ok, lessons:[...]}
     *       {"direction":"push","kind":"episodic"|"skill_lesson","key":...,
     *        "content":{...},"importance":0..1}
     * Best-effort: fail ho to caller silent handle kare.
     */
    @Throws(Exception::class)
    fun syncMemory(store: DeviceStore, body: JSONObject): JSONObject {
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/agent/memory/sync")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    /**
     * p39: blocker/escalation — phone brain terminal fail ho to server ko
     * agent_issue file karo taaki assistant root-cause fix kar sake.
     * POST /api/agent/issues (device auth).
     */
    @Throws(Exception::class)
    fun fileAgentIssue(
        store: DeviceStore,
        severity: String,
        title: String,
        context: JSONObject,
        hypothesis: String? = null,
    ): JSONObject {
        val body = JSONObject()
            .put("agent_id", "phone")
            .put("severity", severity)
            .put("title", title)
            .put("context", context)
        if (!hypothesis.isNullOrBlank()) body.put("root_cause_hypothesis", hypothesis)
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/agent/issues")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    @Throws(Exception::class)
    private fun deviceCall(req: Request): JSONObject {
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (resp.code == 401) {
                throw ApiException(401, json.optString("error", "Device unknown/disconnected (401)"))
            }
            if (!resp.isSuccessful) {
                throw ApiException(
                    resp.code,
                    json.optString("error", "Request failed (HTTP ${resp.code})")
                )
            }
            return json
        }
    }
}
