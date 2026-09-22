package com.clipflow.agent.web

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Login WebView ka setup helper.
 * Cookies WebView ke cookie store me persist rehte hain —
 * app restart / phone reboot ke baad bhi login bana rehta hai.
 */
object LoginWebView {

    /**
     * p50: renderer process mar gaya (crash / OOM-kill — bhari Next.js pages pe
     * hota hai). Default WebViewClient false return karta hai = APP CRASH.
     * true return karo taaki app zinda rahe; engine flag dekh ke honestly fail
     * karega (FAILED_RENDERER_GONE) bajaye silent crash-loop ke.
     */
    @Volatile private var renderGone = false

    /** Flag lo aur reset karo — ek baar consume hone ke baad dobara false. */
    fun consumeRenderGone(): Boolean {
        val v = renderGone
        renderGone = false
        return v
    }

    /**
     * p65 GLOBAL DESKTOP MODE (2026-09-22, user order): app ke SAARE WebViews
     * (automation + Seekhna/learn + browser tab) desktop mode me chalte hain —
     * desktop UA string + desktop Client Hints (Sec-CH-UA-Mobile: ?0,
     * platform Windows). setup() se guzarta har WebView desktop milta hai.
     */
    const val DESKTOP_MODE = true
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/126.0.0.0 Safari/537.36"

    @SuppressLint("SetJavaScriptEnabled")
    fun setup(webView: WebView) {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.acceptThirdPartyCookies(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        if (DESKTOP_MODE) {
            webView.settings.userAgentString = DESKTOP_UA
            // Sirf UA string kaafi nahi — WebView Sec-CH-UA-Mobile: ?1 bhejta
            // rehta hai, jisse server mobile bundle serve karta hai.
            // setUserAgentMetadata se client hints bhi desktop hote hain.
            try {
                androidx.webkit.WebSettingsCompat.setUserAgentMetadata(
                    webView.settings,
                    androidx.webkit.UserAgentMetadata.Builder()
                        .setMobile(false)
                        .setPlatform("Windows")
                        .setModel("")
                        .build()
                )
            } catch (_: Exception) { }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                // p50: renderer died — app mat girao, engine ko signal do.
                renderGone = true
                return true
            }
        }
        // p35: camera/mic HAMESHA silently deny — koi system prompt nahi,
        // koi Android permission nahi chahiye. Instagram upload file chooser
        // (onShowFileChooser) se hota hai, jise getUserMedia chahiye hi nahi.
        // Pehle jaise: user se zero camera/mic access.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // getUserMedia (camera/mic/geolocation-sensor) → deny.
                // File upload isse affect nahi hota (wo onShowFileChooser hai).
                request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                // Location posting ke liye zaroori nahi — hamesha deny
                // (prompt dikhaye bina) taaki beech me popup na aaye.
                callback.invoke(origin, false, false)
            }
        }
    }

    fun openLogin(webView: WebView, url: String) {
        webView.loadUrl(url)
    }

    /** P1 me job engine isi WebView (hidden) ko drive karega. */
    fun flushCookies() {
        CookieManager.getInstance().flush()
    }
}
