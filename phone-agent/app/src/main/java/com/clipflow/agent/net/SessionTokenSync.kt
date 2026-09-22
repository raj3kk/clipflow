package com.clipflow.agent.net

import android.content.Context
import android.webkit.CookieManager
import com.clipflow.agent.data.DeviceStore
import org.json.JSONObject

/**
 * Session-TOKEN sync (p60/p61, 2026-09-21).
 *
 * Whop + Content Rewards ke WebView cookies → server token vault
 * (POST /api/agent/session/tokens). Server cookies ko encrypt karke
 * `connections` me rakhta hai taaki website-side automation (bina phone)
 * bhi logged-in session use kar sake.
 *
 * PRIVACY BOUNDARY: sirf whop + contentrewards — Instagram YAHAAN kabhi
 * nahi (Instagram sirf SessionSync ka login-state monitor dekhta hai).
 *
 * - syncAll(): dono services ka full sync (15-min tick / login detect pe).
 * - maybeSyncForUrl(): page-load pe — URL whop/contentrewards ka ho to
 *   usi service ka sync.
 *
 * Same cookie dobara nahi bhejte (sig memo) — server round-trip bachta hai.
 * Sab best-effort, kabhi throw nahi karta.
 */
object SessionTokenSync {

    /** service id (server wire value) → probe page URL */
    private val SERVICES = listOf(
        "whop" to "https://whop.com/",
        "contentrewards" to "https://contentrewards.com/",
    )

    @JvmStatic
    fun syncAll(ctx: Context, store: DeviceStore) {
        for ((service, pageUrl) in SERVICES) {
            try {
                syncService(ctx, store, service, pageUrl)
            } catch (_: Exception) {
            }
        }
    }

    @JvmStatic
    fun maybeSyncForUrl(ctx: Context, store: DeviceStore, url: String?) {
        if (url.isNullOrBlank()) return
        try {
            val u = url.lowercase()
            val match = SERVICES.firstOrNull { (_, probe) ->
                val host = try {
                    android.net.Uri.parse(probe).host ?: ""
                } catch (_: Exception) {
                    ""
                }
                host.isNotEmpty() && u.contains(host)
            } ?: return
            syncService(ctx, store, match.first, match.second)
        } catch (_: Exception) {
        }
    }

    private fun syncService(ctx: Context, store: DeviceStore, service: String, pageUrl: String) {
        val cm = try { CookieManager.getInstance() } catch (_: Exception) { return }
        val cookieHeader = try { cm.getCookie(pageUrl) } catch (_: Exception) { null }
        if (cookieHeader.isNullOrBlank()) return

        // login cookie na ho to khaali session mat bhejo
        val site = SessionSync.siteById(
            if (service == "whop") "whop" else "content_rewards"
        )
        if (site != null && !SessionSync.checkLoggedIn(site, cookieHeader)) return

        // memo: same cookie dobara nahi
        val sig = (service + "|" + cookieHeader).hashCode().toString()
        val memoKey = "token_sync_sig_$service"
        val prefs = try { store.prefs } catch (_: Exception) { return }
        if (prefs.getString(memoKey, "") == sig) return

        val body = JSONObject()
            .put("service", service)
            .put("cookie_header", cookieHeader)
            .put("page_url", pageUrl)
        val ok = try {
            ApiClient.postSessionTokens(store, body)
        } catch (_: Exception) {
            false
        }
        if (ok) {
            try { prefs.edit().putString(memoKey, sig).apply() } catch (_: Exception) { }
        }
    }
}
