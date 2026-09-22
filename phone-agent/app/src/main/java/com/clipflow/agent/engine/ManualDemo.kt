package com.clipflow.agent.engine

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.widget.Toast
import com.clipflow.agent.work.AutomationViewHost
import org.json.JSONArray
import org.json.JSONObject

/**
 * Ek seekha hua manual tap — user ne khud karke dikhaya.
 * Server ko skill_lesson ("manual-demo") banke jata hai.
 */
data class DemoTap(
    val jobType: String,
    val campaign: String,
    val pageType: String,
    val text: String,
    val desc: String,
    val tag: String,
    val href: String,
    val step: String,
    val ts: Long,
) {
    /** Stable signature — isi pe matching hoti hai. */
    val sig: String get() = ManualDemo.norm(pageType, tag, text, href)
}

/**
 * Manual-demo tap learning (p54, 2026-09-21).
 *
 * Jab user khud app me tap karke koi step karta hai (learning run ke
 * dauraan), wo tap signature seekh liya jata hai:
 *  - local prefs me (prefSigs — reinstall-safe nahi, lekin server push
 *    ke baad server se wapas aa jata hai)
 *  - server shared memory me (skill_lesson, skill="manual-demo") —
 *    AutomationWorker drainForPush() se uthake bhejta hai
 *  - server se aayi lessons ingestServerLessons() se wapas seekhi jati hain
 *
 * Agli baar automation isi signature ka element khud dhoondh sakta hai
 * (matches() gate). Sab best-effort — learning kabhi automation nahi todti.
 */
object ManualDemo {

    private const val PREFS = "manual_demo"
    private const val KEY_PREFS = "pref_sigs_v1"

    private var appCtx: Context? = null
    private var runJobType = ""
    private var runCampaign = ""
    private var learning = false
    private var currentStep = ""
    private val taps = mutableListOf<DemoTap>()

    private var downX = 0f
    private var downY = 0f
    private var downT = 0L
    private var touchActive = false

    /** Koi learning run chal rahi hai? */
    @JvmStatic
    val isActive: Boolean get() = learning

    /** Aakhri tap ka signature (live debugging ke liye). */
    @JvmStatic
    var liveTapSig: String = ""
        private set

    /**
     * Learning run shuru karo. enabled=false (DeviceStore.learnFromUser()
     * off) ho to sirf no-op state — taps record nahi honge.
     */
    @JvmStatic
    fun startRun(ctx: Context, jobType: String, campaign: String, enabled: Boolean) {
        try {
            appCtx = ctx.applicationContext
        } catch (_: Exception) {
            appCtx = ctx
        }
        runJobType = jobType
        runCampaign = campaign
        currentStep = ""
        taps.clear()
        liveTapSig = ""
        learning = enabled
        if (enabled) {
            toast(appCtx, "📚 Seekh raha hoon — aap bas normally tap karte jao")
        }
    }

    /** Run khatam — taps drainForPush() me intezaar karenge. */
    @JvmStatic
    fun endRun() {
        learning = false
        touchActive = false
    }

    /** Automation ka current step — tap isi step se judenge. */
    @JvmStatic
    fun noteStep(label: String) {
        currentStep = label.take(80)
    }

    // ---- touch input (AutomationWebView se) ----

    @JvmStatic
    fun onTouchDown(x: Float, y: Float) {
        downX = x
        downY = y
        downT = System.currentTimeMillis()
        touchActive = true
    }

    @JvmStatic
    fun onTouchUp(x: Float, y: Float) {
        if (!touchActive) return
        touchActive = false
        if (!learning) return
        val dt = System.currentTimeMillis() - downT
        val dist = kotlin.math.hypot((x - downX).toDouble(), (y - downY).toDouble())
        // tap = chhota move + tez press (scroll/long-press nahi)
        if (dist > 24 || dt > 600) return
        recordTap(x, y)
    }

    @JvmStatic
    fun onTouchCancel() {
        touchActive = false
    }

    private fun recordTap(x: Float, y: Float) {
        val step = currentStep
        val jobType = runJobType
        val campaign = runCampaign
        val ts = System.currentTimeMillis()
        val view = AutomationViewHost.liveView
        if (view == null) {
            addTap(DemoTap(jobType, campaign, pageTypeOf(null), "", "", "", "", step, ts))
            return
        }
        // element resolve async — JS se tag/text/href nikalo
        resolveElement(view, x, y) { info ->
            val tap = DemoTap(
                jobType = jobType,
                campaign = campaign,
                pageType = pageTypeOf(info?.optString("url")),
                text = info?.optString("text", "") ?: "",
                desc = info?.optString("desc", "") ?: "",
                tag = info?.optString("tag", "") ?: "",
                href = info?.optString("href", "") ?: "",
                step = step,
                ts = ts,
            )
            addTap(tap)
        }
    }

    @Synchronized
    private fun addTap(tap: DemoTap) {
        taps.add(tap)
        liveTapSig = tap.sig
        bumpPref(tap.sig, goalOf(tap.jobType))
    }

    /**
     * document.elementFromPoint se tap ke neeche ka element nikalo.
     * Callback hamesha aata hai (null = resolve nahi hua).
     */
    private fun resolveElement(view: WebView, x: Float, y: Float, cb: (JSONObject?) -> Unit) {
        try {
            val js = "(function(x,y){" +
                "try{" +
                "var el=document.elementFromPoint(x,y);" +
                "if(!el) return null;" +
                "var a=el.closest?el.closest('a'):null;" +
                "var r={tag:(el.tagName||'').toLowerCase()," +
                "text:((el.innerText||el.textContent||'').trim().slice(0,80))," +
                "desc:(el.getAttribute('aria-label')||el.getAttribute('title')||'')," +
                "href:(el.href||(a?a.href:'')||'')," +
                "url:location.href};" +
                "return JSON.stringify(r);" +
                "}catch(e){ return null; }" +
                "})(" + x + "," + y + ")"
            view.post {
                try {
                    view.evaluateJavascript(js) { raw ->
                        val info = try {
                            if (raw == null || raw == "null") null
                            else JSONObject(JSONTok(raw))
                        } catch (_: Exception) {
                            null
                        }
                        try { cb(info) } catch (_: Exception) { }
                    }
                } catch (_: Exception) {
                    try { cb(null) } catch (_: Exception) { }
                }
            }
        } catch (_: Exception) {
            try { cb(null) } catch (_: Exception) { }
        }
    }

    /** evaluateJavascript quoted JSON wapas deta hai — unquote karo. */
    private fun JSONTok(raw: String): String {
        var s = raw.trim()
        if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length - 1)
            // JS string escapes wapas
            val out = StringBuilder(s.length)
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '\\' && i + 1 < s.length) {
                    val n = s[i + 1]
                    when (n) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'r' -> out.append('\r')
                        'u' -> {
                            if (i + 5 < s.length) {
                                val hex = s.substring(i + 2, i + 6)
                                try {
                                    out.append(hex.toInt(16).toChar())
                                    i += 4
                                } catch (_: Exception) {
                                    out.append(n)
                                }
                            } else out.append(n)
                        }
                        else -> out.append(n)
                    }
                    i += 2
                } else {
                    out.append(c)
                    i++
                }
            }
            return out.toString()
        }
        return s
    }

    // ---- server sync ----

    /**
     * Server se aayi manual-demo lessons seekho (prefs me merge).
     * Lesson shape: {key:"manual-demo.<jobType>", content:{sig?, job_type,
     * campaign, page_type, text, desc, tag, href, step}}.
     */
    @JvmStatic
    fun ingestServerLessons(arr: JSONArray) {
        try {
            for (i in 0 until arr.length()) {
                val l = arr.optJSONObject(i) ?: continue
                val key = l.optString("key", "")
                if (!key.startsWith("manual-demo.")) continue
                val c = l.optJSONObject("content") ?: continue
                val sig = c.optString("sig", "").ifEmpty {
                    norm(
                        c.optString("page_type"),
                        c.optString("tag"),
                        c.optString("text"),
                        c.optString("href"),
                    )
                }
                if (sig.isEmpty()) continue
                val jobType = c.optString("job_type", key.removePrefix("manual-demo."))
                bumpPref(sig, goalOf(jobType), 2)
            }
        } catch (_: Exception) {
        }
    }

    /**
     * Is run ke taps nikalo (server push ke liye) — nikalne ke baad
     * list khaali ho jati hai.
     */
    @JvmStatic
    @Synchronized
    fun drainForPush(): List<DemoTap> {
        val out = taps.toList()
        taps.clear()
        return out
    }

    // ---- matching ----

    /**
     * Kya ye signature is job-type ke goal ke liye seekhi hui hai?
     * Automation isi gate se decide karta hai: seekha hua element mil
     * gaya to user-jaisa tap, nahi to normal brain flow.
     */
    @JvmStatic
    fun matches(sig: String, jobType: String): Boolean {
        if (sig.isEmpty()) return false
        return prefWeight(sig, goalOf(jobType)) >= 2
    }

    /** Seekhi hui signatures (goal → sig → weight). */
    @JvmStatic
    val prefSigs: Map<String, Map<String, Int>>
        get() = readPrefs()

    /** Ek signature ko reinforce karo (user ne phir wahi tap kiya). */
    @JvmStatic
    fun reinforce(sig: String, jobType: String) {
        if (sig.isEmpty()) return
        bumpPref(sig, goalOf(jobType))
    }

    @Synchronized
    private fun bumpPref(sig: String, goal: String, by: Int = 1) {
        try {
            val ctx = appCtx ?: return
            val all = readPrefs().mapValues { it.value.toMutableMap() }.toMutableMap()
            val g = all.getOrPut(goal) { mutableMapOf() }
            g[sig] = (g[sig] ?: 0) + by
            // cap: prefs phoolen nahi — goal pe 200, weight pe 50
            if (g.size > 200) {
                val drop = g.entries.sortedBy { it.value }.take(g.size - 200)
                for (e in drop) g.remove(e.key)
            }
            if ((g[sig] ?: 0) > 50) g[sig] = 50
            writePrefs(all)
        } catch (_: Exception) {
        }
    }

    private fun prefWeight(sig: String, goal: String): Int {
        return try {
            readPrefs()[goal]?.get(sig) ?: 0
        } catch (_: Exception) {
            0
        }
    }

    private fun readPrefs(): Map<String, Map<String, Int>> {
        return try {
            val ctx = appCtx ?: return emptyMap()
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_PREFS, null) ?: return emptyMap()
            val root = JSONObject(raw)
            val out = mutableMapOf<String, Map<String, Int>>()
            val goals = root.keys()
            while (goals.hasNext()) {
                val g = goals.next()
                val o = root.optJSONObject(g) ?: continue
                val m = mutableMapOf<String, Int>()
                val keys = o.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    m[k] = o.optInt(k, 0)
                }
                out[g] = m
            }
            out
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun writePrefs(all: Map<String, Map<String, Int>>) {
        try {
            val ctx = appCtx ?: return
            val root = JSONObject()
            for ((g, m) in all) {
                val o = JSONObject()
                for ((k, v) in m) o.put(k, v)
                root.put(g, o)
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_PREFS, root.toString()).apply()
        } catch (_: Exception) {
        }
    }

    // ---- helpers ----

    /** Job type → learning goal. */
    @JvmStatic
    fun goalOf(jobType: String): String {
        return when (jobType.lowercase()) {
            "join_campaign", "campaign_join" -> "join"
            "render_clip", "clip_render" -> "render"
            "upload_instagram", "ig_upload" -> "upload"
            "submit_whop", "whop_submit" -> "submit"
            "discover_campaigns" -> "discover"
            "live_session" -> "live"
            else -> jobType.lowercase().ifEmpty { "general" }
        }
    }

    /**
     * Stable tap signature: page-bucket + tag + text/href ka normalized
     * fingerprint. Coordinates nahi — alag screen-size pe bhi match kare.
     */
    @JvmStatic
    fun norm(pageType: String?, tag: String?, text: String?, href: String?): String {
        val p = (pageType ?: "").lowercase().take(80)
        val t = (tag ?: "").lowercase().take(20)
        val x = (text ?: "").lowercase()
            .replace(Regex("\\s+"), " ").trim().take(40)
        val h = (href ?: "").lowercase()
            .replace(Regex("^https?://(www\\.)?"), "")
            .substringBefore("?").take(80)
        return listOf(p, t, x, h).joinToString("|")
    }

    private fun pageTypeOf(url: String?): String {
        if (url.isNullOrBlank()) return "unknown"
        return try {
            val u = android.net.Uri.parse(url)
            val host = (u.host ?: "unknown").lowercase()
            val seg = u.pathSegments.firstOrNull()?.take(24) ?: ""
            if (seg.isEmpty()) host else "$host/$seg"
        } catch (_: Exception) {
            "unknown"
        }
    }

    /** Main thread pe chhota toast — learning kabhi crash nahi karegi. */
    @JvmStatic
    fun toast(ctx: Context?, msg: String) {
        if (ctx == null) return
        try {
            val c = ctx.applicationContext ?: ctx
            if (Looper.myLooper() == Looper.getMainLooper()) {
                Toast.makeText(c, msg, Toast.LENGTH_SHORT).show()
            } else {
                Handler(Looper.getMainLooper()).post {
                    try {
                        Toast.makeText(c, msg, Toast.LENGTH_SHORT).show()
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (_: Exception) {
        }
    }
}
