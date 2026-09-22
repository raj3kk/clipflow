package com.clipflow.agent.net

import com.clipflow.agent.BuildConfig
import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
        .addInterceptor(UsEgressInterceptor({ UsEgressInterceptor.sharedStore })) // p63 layer 3
        .build()

    data class EnrollResult(val deviceId: String, val apiKey: String, val deviceNo: String? = null)

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
                apiKey = json.getString("api_key"),
                // Browser Agent v1 (2026-09-21): enroll response me device_no
                // ("AC-0007") aata hai. Server purana ho to field missing → null.
                deviceNo = json.optString("device_no", "").ifEmpty { null },
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
     * p70 (2026-09-22): body me optional `events` (step-event history,
     *   [{t, step, phase, msg, ok}], max 20/call — server live_steps me
     *   likhta hai) + `frame` (base64 JPEG, server live_frame me likhta hai).
     *   Dono null ho to purana behavior (sirf step) — signature ke default
     *   params pichle callers ko nahi todte.
     * Route device auth (X-Device-Id / X-Device-Key) se verify karta hai.
     * Failures caller (JobHeartbeat) me silent handle hoti hain.
     */
    @Throws(Exception::class)
    fun postHeartbeat(
        store: DeviceStore,
        jobId: String,
        step: String,
        sessions: JSONObject? = null,
        events: JSONArray? = null,
        frame: String? = null,
    ): JSONObject {
        val bodyObj = JSONObject().put("step", step)
        if (sessions != null) bodyObj.put("sessions", sessions)
        if (events != null) bodyObj.put("events", events)
        if (frame != null) bodyObj.put("frame", frame)
        val body = bodyObj.toString()
            .toRequestBody("application/json".toMediaType())
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/jobs/$jobId/heartbeat")
            .post(body)
            .build()
        return deviceCall(req)
    }

    /**
     * p70 (2026-09-22): mid-flow proof shot upload.
     * POST /api/devices/jobs/{id}/shot (device auth: X-Device-Id / X-Device-Key),
     * multipart: name (text), shot (JPEG file), step (text),
     * phase / msg (text, optional).
     * Server turant device-shots me save karta hai — timeout/fail pe bhi
     * evidence milti hai (pehle screenshots sirf job END pe report me aate the).
     */
    @Throws(Exception::class)
    fun uploadJobShot(
        store: DeviceStore,
        jobId: String,
        name: String,
        shot: File,
        step: String,
        phase: String? = null,
        msg: String? = null,
    ): JSONObject {
        if (jobId.isEmpty()) throw Exception("uploadJobShot: job_id missing")
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("name", name)
            .addFormDataPart("shot", shot.name, shot.asRequestBody("image/jpeg".toMediaType()))
            .addFormDataPart("step", step)
        if (!phase.isNullOrEmpty()) body.addFormDataPart("phase", phase)
        if (!msg.isNullOrEmpty()) body.addFormDataPart("msg", msg)
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/jobs/$jobId/shot")
            .post(body.build())
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
     */    @Throws(Exception::class)
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

    /**
     * p60 (2026-09-21): WebView session-TOKEN sync — USER-AUTHORIZED.
     * POST /api/agent/session/tokens (device auth).
     * body: { service: "whop"|"contentrewards", cookie_header, page_url? }
     * Sirf whop/contentrewards — Instagram kabhi nahi.
     */
    @Throws(Exception::class)
    fun syncSessionTokens(store: DeviceStore, body: JSONObject): JSONObject {
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/agent/session/tokens")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    /**
     * Browser Agent v1 (2026-09-21): browser login-state sync.
     * POST /api/devices/:id/sessions (device auth).
     * body: { sessions: [{ site, logged_in, account_handle? }] }
     *
     * SECRET RULE: body me sirf site/logged_in/handle — cookies/tokens
     * KABHI nahi (SessionSync me derive hota hai).
     */
    @Throws(Exception::class)
    fun syncSessions(store: DeviceStore, body: JSONObject): JSONObject {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId/sessions")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    /**
     * Browser Agent v1: live_session job ka frame post.
     * POST /api/devices/:id/live/frame (device auth), body { job_id, frame }
     * (frame = base64 JPEG q60, 540px wide, ≤200KB).
     */
    @Throws(Exception::class)
    fun postLiveFrame(store: DeviceStore, jobId: String, frameB64: String): JSONObject {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val body = JSONObject().put("job_id", jobId).put("frame", frameB64)
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId/live/frame")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return deviceCall(req)
    }

    /**
     * Browser Agent v1: live_session ke pending step ka poll.
     * GET /api/devices/:id/live/step?job_id= (device auth).
     * Contract: {ok, step?: <JobEngine step JSON>, stop?: true} — koi pending
     * step nahi to {ok:true} (bina step ke). 404 = job server pe nahi
     * (cancelled/deleted/endpoint purana) → null return karo, caller decide kare.
     * Best-effort helper — 404 null deta hai, baaki errors throw hoti hain.
     */
    @Throws(Exception::class)
    fun getLiveStep(store: DeviceStore, jobId: String): JSONObject? {
        val deviceId = store.deviceId() ?: throw Exception("not enrolled")
        val req = authBuilder(store)
            .url(store.serverUrl() + "/api/devices/$deviceId/live/step?job_id=" +
                java.net.URLEncoder.encode(jobId, "UTF-8"))
            .get()
            .build()
        client.newCall(req).execute().use { resp ->
            if (resp.code == 404) return null
            val text = resp.body?.string().orEmpty()
            val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (resp.code == 401) {
                throw ApiException(401, json.optString("error", "Device unknown/disconnected (401)"))
            }
            if (!resp.isSuccessful) {
                throw ApiException(resp.code, json.optString("error", "live step poll failed (HTTP ${resp.code})"))
            }
            return json
        }
    }

    /**
     * SessionTokenSync: whop/contentrewards cookies → server token vault.
     * POST /api/agent/session/tokens {service, cookie_header, page_url}.
     */
    fun postSessionTokens(store: DeviceStore, payload: JSONObject): Boolean {
        return try {
            val req = authBuilder(store)
                .url(store.serverUrl() + "/api/agent/session/tokens")
                .post(payload.toString().toRequestBody("application/json".toMediaType()))
                .build()
            deviceCall(req).optBoolean("ok", false)
        } catch (_: Exception) {
            false
        }
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
