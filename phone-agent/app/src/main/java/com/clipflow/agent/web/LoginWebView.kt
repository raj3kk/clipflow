package com.clipflow.agent.web

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Login WebView ka setup helper.
 * Cookies WebView ke cookie store me persist rehte hain —
 * app restart / phone reboot ke baad bhi login bana rehta hai.
 */
object LoginWebView {

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
        webView.webViewClient = WebViewClient()
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
