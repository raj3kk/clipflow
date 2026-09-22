package com.clipflow.agent.net

import android.os.Build
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.clipflow.agent.data.DeviceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Per-host USA egress (p63, 2026-09-22).
 *
 * p44 ne WebView ka HAR request (koi bhi host) USA relay se bhejna shuru
 * kiya tha. User-reported: proxy ON = Instagram load hi nahi hota;
 * OFF = chalta hai. Instagram (India account) ko US IP se security-challenge
 * ka risk bhi — isliye p63 se USA relay SIRF allowlisted hosts pe:
 *
 *   whop.com (+ subdomains) aur contentrewards.com (+ subdomains)
 *
 * Baaki sab (Instagram, Google, CDN, ...) hamesha NATIVE DIRECT —
 * chahe Profile tab ka USA Proxy switch ON ho.
 *
 * Fail-closed SIRF allowlisted hosts pe: proxy fail ho to request block hoti
 * hai (direct fallback nahi) — region-locked campaign silently India IP se
 * nahi khulni chahiye. Non-allowlisted hosts pe kabhi block nahi (direct).
 *
 * Teen enforcement layers:
 *  1. Kotlin: isProxyHost/urlIsProxyHost + intercept() (WebViewClient)
 *  2. JS: JS_US_EGRESS_V2 me isProxyHost/urlIsProxyHost mirror
 *     (fetch/XHR/form-submit non-allowlisted pe native direct)
 *  3. OkHttp: UsEgressInterceptor (server-host passthrough + allowlist)
 *
 * p45 binary bypass untouched: file uploads (video binary) proxy se nahi
 * jate (Vercel serverless 4.5MB request limit) — direct jate hain.
 */
object UsEgress {

    /** Sirf in hosts ka traffic USA relay se jata hai. */
    private val PROXY_HOSTS = setOf("whop.com", "contentrewards.com")

    /**
     * Kotlin host matcher — exact ya subdomain.
     * Fail-closed: null/blank/invalid → false (direct).
     */
    @JvmStatic
    fun isProxyHost(host: String?): Boolean {
        val h = host?.trim()?.lowercase()?.trimEnd('.') ?: return false
        if (h.isEmpty()) return false
        return PROXY_HOSTS.any { base -> h == base || h.endsWith(".$base") }
    }

    /** URL string se host nikalke matcher lagao. */
    @JvmStatic
    fun urlIsProxyHost(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        return try {
            isProxyHost(URL(url).host)
        } catch (_: Exception) {
            false
        }
    }

    /**
     * WebView me JS interceptor install karo.
     * window.__usProxyStrict = Profile tab ke USA Proxy switch ki state —
     * JS har request pe allowlist + switch dono check karta hai.
     */
    @JvmStatic
    fun injectJs(view: WebView?, store: DeviceStore) {
        if (view == null) return
        try {
            val strict = try { store.usaProxyEnabled() } catch (_: Exception) { false }
            val js = "window.__usProxyStrict=" + (if (strict) "true" else "false") + ";" + JS_US_EGRESS_V2
            view.post {
                try {
                    view.evaluateJavascript(js, null)
                } catch (_: Exception) {
                }
            }
        } catch (_: Exception) {
        }
    }

    /**
     * WebViewClient.shouldInterceptRequest se call hota hai.
     *
     *  - switch OFF → null (sab direct)
     *  - non-allowlisted host → null (direct)  ← p63 ka core change
     *  - allowlisted + GET → USA relay; fail → blocked page (fail-closed)
     *  - allowlisted + non-GET → blocked page (backstop; in-page POSTs JS
     *    bridge se body samet proxy hote hain)
     */
    @JvmStatic
    fun intercept(request: WebResourceRequest?, store: DeviceStore): WebResourceResponse? {
        return try {
            val url = request?.url?.toString() ?: return null
            val proxyOn = try { store.usaProxyEnabled() } catch (_: Exception) { false }
            if (!proxyOn) return null
            if (!urlIsProxyHost(url)) return null // p63: sirf allowlisted proxy
            val method = (request.method ?: "GET").uppercase()
            if (method != "GET") {
                return blockedResponse("proxy: non-GET navigation blocked (fail-closed)")
            }
            val rj = try {
                proxyFetchVercel(url, "GET", emptyMap(), null, store)
            } catch (e: Exception) {
                null
            } ?: return blockedResponse("proxy fail (fail-closed)")
            try {
                egressJsonToWebResponse(rj)
            } catch (e: Exception) {
                blockedResponse("proxy: bad response (fail-closed)")
            }
        } catch (_: Exception) {
            try {
                if (store.usaProxyEnabled()) blockedResponse("intercept exception (fail-closed)")
                else null
            } catch (_: Exception) {
                null
            }
        }
    }

    /** Fail-closed blocked page. */
    @JvmStatic
    fun blockedResponse(reason: String): WebResourceResponse {
        val safe = reason.replace("<", "&lt;").replace(">", "&gt;").take(200)
        val html = "<html><body style='font-family:sans-serif;padding:32px'>" +
            "<h3>AutoClip proxy blocked</h3><p>$safe</p>" +
            "<p>USA Proxy switch OFF karo ya dobara try karo.</p></body></html>"
        val stream = ByteArrayInputStream(html.toByteArray(Charsets.UTF_8))
        return if (Build.VERSION.SDK_INT >= 21) {
            WebResourceResponse("text/html", "utf-8", 200, "OK",
                mapOf("Content-Type" to "text/html; charset=utf-8"), stream)
        } else {
            @Suppress("DEPRECATION")
            WebResourceResponse("text/html", "utf-8", stream)
        }
    }

    /**
     * Egress endpoint ko POST karo, parsed JSON wapas.
     * null = transport fail (caller fail-closed decide kare).
     * Cookie flow: WebView cookies → Cookie header; set-cookie → WebView.
     */
    @JvmStatic
    fun proxyFetchVercel(
        url: String,
        method: String,
        headers: Map<String, String>,
        bodyB64: String?,
        store: DeviceStore,
    ): JSONObject? {
        val deviceId = store.deviceId() ?: return null
        val deviceKey = store.apiKey() ?: return null
        val serverUrl = store.serverUrl().trimEnd('/')
        if (serverUrl.isEmpty()) return null

        val cm = try { CookieManager.getInstance() } catch (_: Exception) { null }
        val cookies: String? = try { cm?.getCookie(url) } catch (_: Exception) { null }

        val egressBody = JSONObject()
            .put("url", url)
            .put("method", method.uppercase())
        val hOut = JSONObject()
        for ((k, v) in headers) {
            val kl = k.lowercase()
            if (kl == "cookie" || kl == "content-length" || kl == "host") continue
            hOut.put(k, v)
        }
        if (!cookies.isNullOrEmpty()) hOut.put("Cookie", cookies)
        egressBody.put("headers", hOut)
        if (bodyB64 != null) egressBody.put("body_base64", bodyB64)

        val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
        val httpReq = Request.Builder()
            .url("$serverUrl/api/net/egress")
            .addHeader("x-device-id", deviceId)
            .addHeader("x-device-key", deviceKey)
            .post(egressBody.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return try {
            client.newCall(httpReq).execute().use { resp ->
                val respStr = try { resp.body?.string() ?: "{}" } catch (_: Exception) { "{}" }
                val rj = try { JSONObject(respStr) } catch (_: Exception) { return null }
                if (rj.optBoolean("ok", false)) {
                    syncCookiesToWebView(url, rj, store)
                }
                rj
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Egress response ke set-cookie → WebView CookieManager (+ verified region). */
    @JvmStatic
    fun syncCookiesToWebView(url: String, rj: JSONObject, store: DeviceStore) {
        try {
            val cm = CookieManager.getInstance()
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
        } catch (_: Exception) {
        }
    }

    /** Egress JSON → WebResourceResponse (intercept ke liye). */
    @JvmStatic
    fun egressJsonToWebResponse(rj: JSONObject): WebResourceResponse {
        if (!rj.optBoolean("ok", false)) {
            throw IllegalStateException(rj.optString("error", "proxy fail").take(120))
        }
        val status = rj.optInt("status", 200).coerceIn(100, 599)
        val headersObj = rj.optJSONObject("headers") ?: JSONObject()
        val headers = mutableMapOf<String, String>()
        val keys = headersObj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            try { headers[k] = headersObj.optString(k, "") } catch (_: Exception) { }
        }
        val bodyB64 = rj.optString("body_base64", "")
        val bytes = if (bodyB64.isNotEmpty()) {
            try { Base64.decode(bodyB64, Base64.DEFAULT) } catch (_: Exception) { ByteArray(0) }
        } else ByteArray(0)
        val contentType = headers.entries.firstOrNull {
            it.key.equals("content-type", ignoreCase = true)
        }?.value ?: "application/octet-stream"
        val mime = contentType.substringBefore(";").trim().ifEmpty { "application/octet-stream" }
        val encoding = if (contentType.contains("charset=", ignoreCase = true))
            contentType.substringAfter("charset=", "").substringBefore(";").trim()
                .ifEmpty { "utf-8" } else "utf-8"
        val stream = ByteArrayInputStream(bytes)
        return if (Build.VERSION.SDK_INT >= 21) {
            val reason = when (status) {
                200 -> "OK"; 201 -> "Created"; 204 -> "No Content"
                301 -> "Moved Permanently"; 302 -> "Found"; 304 -> "Not Modified"
                400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"
                404 -> "Not Found"; 429 -> "Too Many Requests"
                500 -> "Internal Server Error"; 502 -> "Bad Gateway"; 503 -> "Service Unavailable"
                else -> "OK"
            }
            WebResourceResponse(mime, encoding, status, reason, headers, stream)
        } else {
            @Suppress("DEPRECATION")
            WebResourceResponse(mime, encoding, stream)
        }
    }

    /** Egress JSON → okhttp3.Response (UsEgressInterceptor ke liye). */
    @JvmStatic
    fun egressJsonToOkHttpResponse(
        chain: okhttp3.Interceptor.Chain,
        request: okhttp3.Request,
        rj: JSONObject,
    ): okhttp3.Response {
        if (!rj.optBoolean("ok", false)) {
            throw java.io.IOException(
                "proxy: " + rj.optString("error", "fail").take(160) + " (fail-closed)")
        }
        val status = rj.optInt("status", 200).coerceIn(100, 599)
        val headersObj = rj.optJSONObject("headers") ?: JSONObject()
        val hb = okhttp3.Headers.Builder()
        val keys = headersObj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            try {
                val kl = k.lowercase()
                if (kl == "content-length" || kl == "transfer-encoding" || kl == "content-encoding") continue
                hb.add(k, headersObj.optString(k, ""))
            } catch (_: Exception) { }
        }
        val bodyB64 = rj.optString("body_base64", "")
        val bytes = if (bodyB64.isNotEmpty()) {
            try { Base64.decode(bodyB64, Base64.DEFAULT) } catch (_: Exception) { ByteArray(0) }
        } else ByteArray(0)
        val contentType = headersObj.optString("Content-Type",
            headersObj.optString("content-type", "application/octet-stream"))
        val mediaType = try { contentType.toMediaType() } catch (_: Exception) {
            "application/octet-stream".toMediaType()
        }
        val body = bytes.toResponseBody(mediaType)
        return okhttp3.Response.Builder()
            .request(request)
            .protocol(okhttp3.Protocol.HTTP_1_1)
            .code(status)
            .message("proxied")
            .headers(hb.build())
            .body(body)
            .build()
    }

    /**
     * JS_US_EGRESS_V2 — fetch/XHR/form-submit mirror (layer 2).
     *
     * p63: har request pe pehle allowlist check — non-allowlisted URL
     * native direct jati hai (proxy bridge ko touch hi nahi hota).
     * Fail-closed SIRF allowlisted hosts pe: proxy fail → error event,
     * silent direct fallback nahi.
     *
     * p45 binary bypass untouched: FormData/Blob me File mile to request
     * hamesha native direct (video upload proxy se technically impossible).
     *
     * window.__usProxyStrict — Kotlin injectJs() se set hota hai
     * (Profile tab ka USA Proxy switch). Har request pe re-read hota hai
     * taaki toggle bina page-reload ke kaam kare.
     */
    const val JS_US_EGRESS_V2: String = """
(function(){
  if(window.__usProxyInstalled) return 'already';
  window.__usProxyInstalled = true;
  // p63: PER-HOST USA routing — sirf whop.com + subdomains aur
  // contentrewards.com + subdomains proxy se. Baaki sab hamesha direct.
  var PROXY_HOSTS = ['whop.com','contentrewards.com'];
  function isProxyHost(h){
    if(!h) return false;
    h = String(h).toLowerCase().replace(/\.$/,'');
    for(var i=0;i<PROXY_HOSTS.length;i++){
      var b = PROXY_HOSTS[i];
      if(h===b || h.slice(-(b.length+1))==='.'+b) return true;
    }
    return false;
  }
  function urlIsProxyHost(u){
    try{ return isProxyHost(new URL(u, location.href).hostname); }
    catch(e){ return false; }
  }
  function strictOn(){
    try{ return !!window.__usProxyStrict; }catch(e){ return false; }
  }
  function proxyAllowed(absUrl){
    // switch OFF ya non-allowlisted host → native direct
    return strictOn() && urlIsProxyHost(absUrl);
  }
  function absUrlOf(u){
    try{ return new URL(u, location.href).href; }catch(e){ return null; }
  }
  function b64enc(str){ return btoa(unescape(encodeURIComponent(str))); }
  function b64dec(b64){
    var bin=atob(b64), n=bin.length, bytes=new Uint8Array(n);
    for(var i=0;i<n;i++) bytes[i]=bin.charCodeAt(i);
    return bytes;
  }
  function bodyToB64(body){
    return new Promise(function(resolve){
      if(body==null){ resolve(null); return; }
      if(typeof body==='string'){ resolve(b64enc(body)); return; }
      if(body instanceof URLSearchParams){ resolve(b64enc(body.toString())); return; }
      if(body instanceof FormData){
        // text fields → urlencoded; file entries → bypass signal
        try{
          var hasFile=false, params=new URLSearchParams();
          body.forEach(function(v,k){
            if(v instanceof File) hasFile=true; else params.append(k,v);
          });
          if(hasFile){ resolve('__FILE__'); return; }
          resolve(b64enc(params.toString())); return;
        }catch(e){ resolve(null); return; }
      }
      var p;
      try{
        if(body instanceof Blob) p=body.arrayBuffer();
        else if(body&&body.buffer instanceof ArrayBuffer) p=Promise.resolve(body.buffer);
        else p=new Response(body).arrayBuffer();
      }catch(e){ resolve(null); return; }
      p.then(function(buf){
        var bytes=new Uint8Array(buf), bin='', CH=8192, i;
        for(i=0;i<bytes.length;i+=CH){
          bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+CH));
        }
        resolve(btoa(bin));
      }, function(){ resolve(null); });
    });
  }
  function headersToObj(h){
    var o={};
    if(!h) return o;
    try{
      if(h instanceof Headers){ h.forEach(function(v,k){o[k]=v;}); }
      else if(Array.isArray(h)){ h.forEach(function(p){o[p[0]]=p[1];}); }
      else { for(var k in h) o[k]=h[k]; }
    }catch(e){}
    return o;
  }
  function viaProxy(url, method, headers, bodyB64){
    return new Promise(function(resolve, reject){
      var bridge=null;
      try{ bridge=window.__usProxy; }catch(e){}
      if(!bridge||!bridge.proxyFetch){ reject(new Error('no bridge')); return; }
      var resJson;
      try{
        resJson=bridge.proxyFetch(JSON.stringify({url:url,method:method,headers:headers,body_base64:bodyB64}));
      }catch(e){ reject(e); return; }
      var r;
      try{ r=JSON.parse(resJson); }catch(e){ reject(new Error('bad proxy json')); return; }
      if(!r.ok){ reject(new Error('proxy: '+(r.error||'fail'))); return; }
      var bodyBytes=r.body_base64?b64dec(r.body_base64):new Uint8Array(0);
      var rh=new Headers();
      var hh=r.headers||{};
      for(var k in hh){ try{ rh.append(k, hh[k]); }catch(e){} }
      var resp=new Response(bodyBytes,{status:r.status||200,headers:rh});
      try{ resp.__upFinalUrl=r.final_url||url; }catch(e){}
      resolve(resp);
    });
  }
  var origFetch=window.fetch.bind(window);
  window.fetch=function(input, init){
    var url=typeof input==='string'?input:((input&&input.url)||'');
    var self=this, args=arguments;
    var abs=absUrlOf(url);
    // p63: non-allowlisted ya switch OFF → native direct
    if(abs===null || !proxyAllowed(abs)) return origFetch.apply(self, args);
    var method=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    return (async function(){
      var headers=headersToObj((init&&init.headers)||(input&&input.headers));
      var body=init?init.body:(input&&input.body);
      var b64=await bodyToB64(body);
      if(b64==='__FILE__'){
        // p45 binary bypass: file uploads Vercel serverless 4.5MB limit se
        // proxy technically impossible — direct jane do.
        return origFetch.apply(self, args);
      }
      if(b64===null&&body!=null) throw new Error('proxy: body not serializable (fail-closed)');
      if(body instanceof FormData && b64!==null){
        headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';
      }
      return await viaProxy(abs,method,headers,b64);
    })();
  };
  // XHR: allowlisted → proxy via fetch-bridge, phir fake XHR response
  var origOpen=XMLHttpRequest.prototype.open;
  var origSend=XMLHttpRequest.prototype.send;
  var origSetH=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(method,url){
    this.__upUrl=url; this.__upMethod=method; this.__upHeaders={};
    return origOpen.apply(this,arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader=function(k,v){
    try{ (this.__upHeaders=this.__upHeaders||{})[k]=v; }catch(e){}
    return origSetH.apply(this,arguments);
  };
  XMLHttpRequest.prototype.send=function(body){
    var xhr=this, url=xhr.__upUrl||'';
    var abs=absUrlOf(url);
    // p63: non-allowlisted ya switch OFF → native direct
    if(abs===null || !proxyAllowed(abs)){ return origSend.call(xhr, body); }
    function fail(){ try{ if(xhr.onerror) xhr.onerror(new Event('error')); }catch(e){} }
    (async function(){
      try{
        var b64=await bodyToB64(body);
        if(b64==='__FILE__'){ return origSend.call(xhr, body); }
        if(b64===null&&body!=null){ fail(); return; }
        var hdrs=xhr.__upHeaders||{};
        if(body instanceof FormData && b64!==null){
          hdrs['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';
        }
        var resp=await viaProxy(abs,(xhr.__upMethod||'GET').toUpperCase(),hdrs,b64);
        var text=await resp.text();
        try{
          Object.defineProperties(xhr,{
            status:{value:resp.status,configurable:true},
            statusText:{value:'',configurable:true},
            responseText:{value:text,configurable:true},
            response:{value:text,configurable:true},
            readyState:{value:4,configurable:true}
          });
        }catch(e){}
        try{ if(xhr.onreadystatechange) xhr.onreadystatechange(); }catch(e){}
        try{ if(xhr.onload) xhr.onload(); }catch(e){}
      }catch(e){ fail(); }
    })();
  };
  // HTML form submit → bridge (native form POST ka body WebView expose nahi karta).
  document.addEventListener('submit', function(ev){
    var form=ev.target;
    if(!form||form.tagName!=='FORM') return;
    var href;
    try{ href=new URL(form.action||location.href, location.href).href; }
    catch(e){ return; }
    // p63: non-allowlisted ya switch OFF → native submit
    if(!proxyAllowed(href)) return;
    // p45 binary bypass: file wale forms native direct submit
    // (proxy se pehle check — preventDefault mat karo).
    var preHasFile=false;
    try{
      var preFd=new FormData(form);
      preFd.forEach(function(v){ if(v instanceof File) preHasFile=true; });
    }catch(e){}
    if(preHasFile) return;
    ev.preventDefault();
    ev.stopPropagation();
    (async function(){
      try{
        var method=(form.method||'GET').toUpperCase();
        var fd=new FormData(form);
        var hasFile=false, params=new URLSearchParams();
        fd.forEach(function(v,k){ if(v instanceof File) hasFile=true; else params.append(k,v); });
        if(hasFile) throw new Error('proxy: unexpected file (pre-check miss)');
        var headers={}, b64=null;
        if(method==='GET'){
          href+=(href.indexOf('?')<0?'?':'&')+params.toString();
        }else{
          b64=b64enc(params.toString());
          headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';
        }
        var resJson;
        try{
          var bridge=window.__usProxy;
          resJson=bridge.proxyFetch(JSON.stringify({url:href,method:method,headers:headers,body_base64:b64}));
        }catch(e){ throw new Error('proxy: '+((e&&e.message)||'fail')); }
        var r=JSON.parse(resJson);
        if(!r.ok) throw new Error('proxy: '+(r.error||'fail'));
        var bytes=r.body_base64?b64dec(r.body_base64):new Uint8Array(0);
        var text=new TextDecoder('utf-8').decode(bytes);
        document.open(); document.write(text); document.close();
        try{ history.replaceState(null,'',r.final_url||href); }catch(e){}
      }catch(e){
        try{ form.dispatchEvent(new CustomEvent('up-proxy-error',{detail:String((e&&e.message)||e)})); }catch(_){}
      }
    })();
  }, true);
  return 'installed';
})()
"""
}
