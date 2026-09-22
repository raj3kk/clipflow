package com.clipflow.agent.net

import android.content.Context
import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Server ko phone ki presence batane wale best-effort calls.
 * Dono silent-fail hain (caller ko try/catch ki zaroorat nahi) —
 * poll/schedule backup ki tarah ye sirf "nice to have" hai.
 *
 * Koi secret yahan hardcode nahi — X-Device-Id/X-Device-Key headers
 * DeviceStore ke enrolled credentials se aate hain.
 */
object PresenceClient {

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .addInterceptor(UsEgressInterceptor({ UsEgressInterceptor.sharedStore })) // p63 layer 3
        .build()

    private val JSON: okhttp3.MediaType = "application/json".toMediaType()

    /** FCM token → server pe register taaki "Run Now" push bhej sake. */
    fun registerFcmToken(context: Context, token: String) {
        try {
            val store = DeviceStore(context)
            val deviceId = store.deviceId() ?: return
            val apiKey = store.apiKey() ?: return
            val body = JSONObject().put("fcm_token", token).toString().toRequestBody(JSON)
            val req = Request.Builder()
                .url(store.serverUrl() + "/api/devices/me/fcm-token")
                .header("X-Device-Id", deviceId)
                .header("X-Device-Key", apiKey)
                .post(body)
                .build()
            http.newCall(req).execute().close()
        } catch (_: Exception) {
            // silent — agli baar token refresh / app launch pe phir try hoga
        }
    }

    /** state = "online" | "sleeping". Server dashboard pe dikhata hai. */
    fun postPresence(context: Context, state: String) {
        try {
            val store = DeviceStore(context)
            val deviceId = store.deviceId() ?: return
            val apiKey = store.apiKey() ?: return
            val body = JSONObject().put("state", state).toString().toRequestBody(JSON)
            val req = Request.Builder()
                .url(store.serverUrl() + "/api/devices/me/presence")
                .header("X-Device-Id", deviceId)
                .header("X-Device-Key", apiKey)
                .post(body)
                .build()
            http.newCall(req).execute().close()
        } catch (_: Exception) {
            // silent — presence optional hai
        }
    }
}
