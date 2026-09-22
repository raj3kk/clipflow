package com.clipflow.agent.net

import com.clipflow.agent.data.DeviceStore
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer

/**
 * Proxy policy ka OkHttp enforcement point (layer 3, p63).
 *
 * JobPoller/ApiClient jaise API clients ke OkHttp stack me lagta hai
 * (p59 me JobPoller me tha):
 *
 *  - server host → hamesha passthrough (API calls kabhi proxy nahi)
 *  - switch OFF → direct
 *  - non-allowlisted host → direct  ← p63
 *  - allowlisted host + switch ON → USA egress via proxy;
 *    proxy fail → IOException (fail-closed, silent direct nahi)
 *
 * p45 binary bypass: 4MB se badi body proxy se nahi jati (Vercel
 * serverless 4.5MB request limit) — direct jati hai.
 */
class UsEgressInterceptor : Interceptor {

    companion object {
        /** Egress request body cap — isse badi body direct (p45). */
        const val PROXY_BODY_CAP_BYTES = 4 * 1024 * 1024L

        /** Singleton API clients (ApiClient/PresenceClient/UpdateChecker) ke liye shared store. */
        @Volatile
        var sharedStore: DeviceStore? = null

        /** AgentApp.onCreate se ek baar call hota hai. */
        @JvmStatic
        fun bindSharedStore(store: DeviceStore) {
            sharedStore = store
        }
    }

    private val storeProvider: () -> DeviceStore?

    /** Direct store (jaise JobPoller). */
    constructor(store: DeviceStore) : this({ store })

    /** Lazy provider (singleton clients — store bind hone se pehle bhi safe). */
    constructor(storeProvider: () -> DeviceStore?) {
        this.storeProvider = storeProvider
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val host = req.url.host

        val store = try { storeProvider() } catch (_: Exception) { null }
        val proxyOn = try { store?.usaProxyEnabled() ?: false } catch (_: Exception) { false }
        if (!proxyOn) return chain.proceed(req)

        // 1) server host hamesha passthrough — API calls kabhi proxy nahi
        val serverHost = try {
            store?.let { it.serverUrl().trimEnd('/').toHttpUrlOrNull()?.host }
        } catch (_: Exception) {
            null
        }
        if (!serverHost.isNullOrEmpty() && host.equals(serverHost, ignoreCase = true)) {
            return chain.proceed(req)
        }

        // 2) p63: non-allowlisted host → direct
        if (!UsEgress.isProxyHost(host)) return chain.proceed(req)

        // 3) allowlisted + switch ON → proxy (fail-closed)
        if (store == null) return chain.proceed(req) // store nahi = switch state unknown → direct
        val method = req.method.uppercase()
        val bodyB64: String? = if (method == "GET" || method == "HEAD") {
            null
        } else {
            val bodyBytes = readBodyBytes(req) ?: return chain.proceed(req) // unreadable → direct
            if (bodyBytes.size > PROXY_BODY_CAP_BYTES) {
                return chain.proceed(req) // p45: binary direct
            }
            android.util.Base64.encodeToString(bodyBytes, android.util.Base64.NO_WRAP)
        }
        val headers = mutableMapOf<String, String>()
        for (i in 0 until req.headers.size) {
            headers[req.headers.name(i)] = req.headers.value(i)
        }
        val rj = try {
            UsEgress.proxyFetchVercel(req.url.toString(), method, headers, bodyB64, store)
        } catch (e: Exception) {
            null
        } ?: throw java.io.IOException("proxy fail (fail-closed): allowlisted host $host")
        return UsEgress.egressJsonToOkHttpResponse(chain, req, rj)
    }

    private fun readBodyBytes(req: okhttp3.Request): ByteArray? {
        val body = req.body ?: return ByteArray(0)
        return try {
            val buf = Buffer()
            body.writeTo(buf)
            val bytes = buf.readByteArray()
            if (bytes.size > PROXY_BODY_CAP_BYTES) null else bytes
        } catch (_: Exception) {
            null
        }
    }
}
