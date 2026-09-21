package com.clipflow.agent.net

import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * USA egress bridge (p35, 2026-09-20).
 *
 * WebView me inject kiye gaye JS fetch/XHR interceptor ka native bridge.
 * whop.com / contentrewards.com ke requests Vercel (iad1, Virginia, USA)
 * se forward hote hain taaki region-locked campaigns
 * ("not available in your region") join ho saken.
 *
 * Cookie flow:
 *  - Request se pehle WebView ke cookies (CookieManager) egress request me
 *    `Cookie` header banke jate hain → Whop session bana rehta hai.
 *  - Response ke `set-cookie` wapas CookieManager me likhe jate hain
 *    (HttpOnly cookies bhi — native side se allowed hai).
 *
 * @JavascriptInterface calls WebView ke background thread pe chalte hain,
 * isliye yahan blocking network OK hai (30s timeout).
 */
class UsEgressBridge(private val store: DeviceStore) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * JS se: proxyFetch(JSON.stringify({url, method, headers, body_base64}))
     * Returns: JSON.stringify({ok, status, headers, body_base64, error?})
     */
    @JavascriptInterface
    fun proxyFetch(reqJson: String): String {
        return try {
            doProxy(reqJson)
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", (e.message ?: "proxy fail").take(200))
                .toString()
        }
    }

    private fun doProxy(reqJson: String): String {
        val req = JSONObject(reqJson)
        val url = req.getString("url")
        val method = req.optString("method", "GET").uppercase()
        val headers = req.optJSONObject("headers") ?: JSONObject()
        val bodyB64 = req.optString("body_base64", "").ifEmpty { null }

        val deviceId = store.deviceId() ?: return err("no device")
        val deviceKey = store.apiKey() ?: return err("no api key")
        val serverUrl = store.serverUrl().trimEnd('/')

        // WebView ke cookies → egress request
        val cm = CookieManager.getInstance()
        val cookies: String? = try { cm.getCookie(url) } catch (_: Exception) { null }

        val egressBody = JSONObject()
            .put("url", url)
            .put("method", method)
        val hOut = JSONObject()
        val keys = headers.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            hOut.put(k, headers.optString(k, ""))
        }
        if (!cookies.isNullOrEmpty()) hOut.put("Cookie", cookies)
        egressBody.put("headers", hOut)
        if (bodyB64 != null) egressBody.put("body_base64", bodyB64)

        val httpReq = Request.Builder()
            .url("$serverUrl/api/net/egress")
            .addHeader("x-device-id", deviceId)
            .addHeader("x-device-key", deviceKey)
            .post(egressBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(httpReq).execute().use { resp ->
            val respStr = try { resp.body?.string() ?: "{}" } catch (_: Exception) { "{}" }
            val rj = try { JSONObject(respStr) } catch (_: Exception) { return err("bad egress json") }

            // Set-Cookie wapas WebView ke store me (HttpOnly bhi OK — native side)
            if (rj.optBoolean("ok", false)) {
                // p43: proxy ne bataya kaunse Vercel region se nikla —
                // Profile tab me "Virginia, USA • verified" dikhane ke liye.
                val region = rj.optString("region", "")
                if (region.isNotEmpty() && region != "unknown") {
                    try { store.setUsaProxyVerified(region) } catch (_: Exception) { }
                }
                val setCookies = rj.optJSONArray("set_cookies")
                if (setCookies != null) {
                    for (i in 0 until setCookies.length()) {
                        try { cm.setCookie(url, setCookies.getString(i)) } catch (_: Exception) { }
                    }
                }
                val single = rj.optJSONObject("headers")?.optString("x-egress-set-cookie", "")
                if (!single.isNullOrEmpty()) {
                    try { cm.setCookie(url, single) } catch (_: Exception) { }
                }
                try { cm.flush() } catch (_: Exception) { }
            }
            return rj.toString()
        }
    }

    private fun err(msg: String): String =
        JSONObject().put("ok", false).put("error", msg).toString()

    companion object {
        /** base64 helpers (JS bhi btoa/atob use karta hai) */
        @JvmStatic fun b64enc(bytes: ByteArray): String =
            Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
