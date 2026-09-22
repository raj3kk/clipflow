package com.clipflow.agent.web

import android.webkit.CookieManager

/**
 * Whop/Instagram login state — WebView ke cookies se best-effort check.
 * CookieManager app-wide singleton hai, isliye MainActivity aur
 * RunnerService (coin tick) dono yahin se poochte hain.
 *
 * Markers best-effort hain: galat dikhe to real device pe adjust karna.
 */
object LoginState {

    const val WHOP_LOGIN_URL = "https://whop.com/login/"
    const val IG_LOGIN_URL = "https://www.instagram.com/accounts/login/"

    private fun hasSessionCookie(url: String, markers: List<String>): Boolean {
        return try {
            val c = CookieManager.getInstance().getCookie(url).orEmpty()
            if (c.isBlank()) return false
            val lc = c.lowercase()
            markers.any { lc.contains(it) }
        } catch (_: Exception) {
            false
        }
    }

    fun hasAnyCookies(url: String): Boolean {
        return try {
            CookieManager.getInstance().getCookie(url).orEmpty().isNotBlank()
        } catch (_: Exception) {
            false
        }
    }

    fun whopLoggedIn(): Boolean =
        hasSessionCookie(
            "https://whop.com/",
            listOf("session", "auth", "token", "_whop", "whop", "logged")
        ) || hasSessionCookie(
            "https://app.whop.com/",
            listOf("session", "auth", "token", "_whop", "whop", "logged")
        )

    fun igLoggedIn(): Boolean =
        hasSessionCookie(IG_LOGIN_URL, listOf("sessionid"))

    /** Automation gate: dono login zaroori. */
    fun loginsOk(): Boolean = whopLoggedIn() && igLoggedIn()
}
