package com.clipflow.agent.net

import android.content.Context
import android.webkit.CookieManager
import com.clipflow.agent.data.DeviceStore
import org.json.JSONArray
import org.json.JSONObject

/**
 * Site session monitor (p53/p59, 2026-09-21).
 *
 * WebView ke cookies se 6 sites ka login status nikalta hai:
 * Instagram, Whop, Content Rewards, YouTube, Google, TikTok.
 *
 * - sync(): full status → prefs me save (DeviceStore.sessionSyncJson) +
 *   POST /api/devices/:id/sessions (best-effort, 404 tolerant — server pe
 *   ye route abhi nahi hai).
 * - maybeSyncForUrl(): har page-load pe relevant site ka quick re-check.
 *
 * NOTE: ye SIRF login-state monitor hai — session TOKEN vault me nahi
 * jata. Tokens ke liye SessionTokenSync (sirf whop + contentrewards).
 */
object SessionSync {

    data class Site(
        val id: String,
        val label: String,
        /** login detect karne wale cookie names (koi ek mile to logged-in) */
        val loginCookies: List<String>,
        /** CookieManager.getCookie() ke liye probe URL */
        val probeUrl: String,
        /** page-load pe quick match ke liye host fragments */
        val urlHosts: List<String>,
    )

    data class SiteStatus(
        val site: Site,
        val loggedIn: Boolean,
        val detail: String,
    )

    val SITES = listOf(
        Site("instagram", "Instagram",
            listOf("sessionid"), "https://www.instagram.com/",
            listOf("instagram.com")),
        Site("whop", "Whop",
            listOf("next-auth.session-token", "__Secure-next-auth.session-token"),
            "https://whop.com/",
            listOf("whop.com")),
        Site("content_rewards", "Content Rewards",
            listOf("cr_session", "session", "crsid"),
            "https://contentrewards.com/",
            listOf("contentrewards.com")),
        Site("youtube", "YouTube",
            listOf("LOGIN_INFO"), "https://www.youtube.com/",
            listOf("youtube.com", "youtu.be")),
        Site("google", "Google",
            listOf("SID", "__Secure-1PSID", "__Secure-3PSID"),
            "https://accounts.google.com/",
            listOf("google.com", "accounts.google.com")),
        Site("tiktok", "TikTok",
            listOf("sessionid", "sid_tt"), "https://www.tiktok.com/",
            listOf("tiktok.com")),
    )

    @JvmStatic
    fun siteById(id: String): Site? = SITES.firstOrNull { it.id == id }

    /** Cookie header me login cookie mile to true. */
    @JvmStatic
    fun checkLoggedIn(site: Site, cookieHeader: String): Boolean {
        if (cookieHeader.isBlank()) return false
        val names = cookieHeader.split(";")
            .map { it.substringBefore("=").trim().lowercase() }
            .toSet()
        return site.loginCookies.any { it.lowercase() in names }
    }

    /** CookieManager se ek site ke cookies padho. */
    @JvmStatic
    fun cookiesFor(site: Site): String {
        return try {
            CookieManager.getInstance().getCookie(site.probeUrl) ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    /** Saare sites ka current status. */
    @JvmStatic
    fun collectStatus(ctx: Context): List<SiteStatus> {
        return SITES.map { site ->
            val cookies = cookiesFor(site)
            val loggedIn = checkLoggedIn(site, cookies)
            SiteStatus(
                site = site,
                loggedIn = loggedIn,
                detail = if (loggedIn) "logged-in" else "logged-out",
            )
        }
    }

    /** Status list → compact JSON string. */
    @JvmStatic
    fun statusToJson(list: List<SiteStatus>): String {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        for (s in list) {
            arr.put(
                JSONObject()
                    .put("site", s.site.id)
                    .put("label", s.site.label)
                    .put("logged_in", s.loggedIn)
                    .put("detail", s.detail)
                    .put("at", now)
            )
        }
        return JSONObject().put("sites", arr).put("at", now).toString()
    }

    /**
     * Full sync: status collect → prefs save → server POST (best-effort).
     * Kabhi throw nahi karta.
     */
    @JvmStatic
    fun sync(ctx: Context, store: DeviceStore, from: String = "auto") {
        try {
            val list = collectStatus(ctx)
            val json = statusToJson(list)
            try { store.saveSessionSyncJson(json) } catch (_: Exception) { }
            try {
                val body = JSONObject(json).put("from", from)
                ApiClient.syncSessions(store, body)
            } catch (_: Exception) {
                // server route abhi nahi hai (404) ya net blip — best-effort
            }
        } catch (_: Exception) {
        }
    }

    /**
     * Har page-load pe call hota hai — URL se relevant site nikalo aur
     * sirf uska status refresh karo (poora sync nahi, halka hai).
     */
    @JvmStatic
    fun maybeSyncForUrl(ctx: Context, store: DeviceStore, url: String?) {
        if (url.isNullOrBlank()) return
        try {
            val u = url.lowercase()
            val site = SITES.firstOrNull { s -> s.urlHosts.any { u.contains(it) } }
                ?: return
            val cookies = cookiesFor(site)
            val loggedIn = checkLoggedIn(site, cookies)
            // prefs me maujooda snapshot update karo
            try {
                val prev = store.sessionSyncJson()
                val root = if (prev.isNullOrBlank()) JSONObject() else JSONObject(prev)
                val arr = root.optJSONArray("sites") ?: JSONArray()
                var found = false
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optString("site") == site.id) {
                        o.put("logged_in", loggedIn)
                        o.put("detail", if (loggedIn) "logged-in" else "logged-out")
                        o.put("at", System.currentTimeMillis())
                        found = true
                    }
                }
                if (!found) {
                    arr.put(
                        JSONObject()
                            .put("site", site.id)
                            .put("label", site.label)
                            .put("logged_in", loggedIn)
                            .put("detail", if (loggedIn) "logged-in" else "logged-out")
                            .put("at", System.currentTimeMillis())
                    )
                }
                root.put("sites", arr)
                root.put("at", System.currentTimeMillis())
                store.saveSessionSyncJson(root.toString())
            } catch (_: Exception) {
            }
        } catch (_: Exception) {
        }
    }
}
