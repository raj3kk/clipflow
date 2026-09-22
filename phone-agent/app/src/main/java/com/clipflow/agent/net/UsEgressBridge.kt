package com.clipflow.agent.net

import android.util.Base64
import android.webkit.JavascriptInterface
import com.clipflow.agent.data.DeviceStore
import org.json.JSONObject

/**
 * USA egress bridge (p35, 2026-09-20).
 *
 * WebView me inject kiye gaye JS fetch/XHR interceptor ka native bridge
 * (`window.__usProxy`).
 *
 * p63 (2026-09-22): bridge forward karne se PEHLE host validate karta hai —
 * sirf whop.com / contentrewards.com (+ subdomains) allowlisted hain.
 * Switch OFF ya non-allowlisted host → {ok:false} (fail-closed, direct
 * fallback nahi). Cookie sync (WebView ↔ egress) UsEgress me shared hai.
 *
 * @JavascriptInterface calls WebView ke background thread pe chalte hain,
 * isliye yahan blocking network OK hai (30s timeout).
 */
class UsEgressBridge(private val store: DeviceStore) {

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
        val url = req.optString("url", "")
        if (url.isBlank()) return err("proxy: empty url")
        val method = req.optString("method", "GET").uppercase()
        val headers = req.optJSONObject("headers") ?: JSONObject()
        val bodyB64 = req.optString("body_base64", "").ifEmpty { null }

        // p63: forward se PEHLE validation (fail-closed)
        val proxyOn = try { store.usaProxyEnabled() } catch (_: Exception) { false }
        if (!proxyOn) return err("proxy: USA Proxy switch OFF hai")
        if (!UsEgress.urlIsProxyHost(url)) {
            return err("proxy: host allowlisted nahi (sirf Whop/Content Rewards)")
        }

        val hMap = mutableMapOf<String, String>()
        val keys = headers.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            try { hMap[k] = headers.optString(k, "") } catch (_: Exception) { }
        }

        val rj = try {
            UsEgress.proxyFetchVercel(url, method, hMap, bodyB64, store)
        } catch (e: Exception) {
            null
        } ?: return err("proxy: egress fail (fail-closed)")
        return rj.toString()
    }

    private fun err(msg: String): String =
        JSONObject().put("ok", false).put("error", msg).toString()

    companion object {
        /** base64 helpers (JS bhi btoa/atob use karta hai) */
        @JvmStatic fun b64enc(bytes: ByteArray): String =
            Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
