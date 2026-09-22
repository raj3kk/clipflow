package com.clipflow.agent.engine

import android.content.Context
import org.json.JSONObject

/**
 * AgentBrain v2 — ClipFlow automation ka "dimaag" (p38, 2026-09-20).
 * p39: knowledge pack (training = knowledge injection; model weights retrain
 * nahi hote — ye honest note core-loop.md me hai). AgentBrain har DECIDE
 * step pe bundled `agent_knowledge.json` consult karta hai aur reasoning
 * trace me rule ID cite karta hai (auditability). Server memory-sync se
 * `knowledge.*` lessons bhej ke rules update kar sakta hai — bina APK ke.
 *
 * v1 (p37) ki kamiyan jo yahan fix hain:
 *  1. v1 me tap→verify sirf 1-2 round tha. Lock dabane ke baad naya screen
 *     (join modal / rewards dashboard / interstitial) aaye to v1 uspe dobara
 *     SOCHTA nahi tha — sirf "goal achieve hua?" poochta tha. v2 me poora
 *     multi-screen loop hai: perceive → decide → act → rescan, jab tak
 *     terminal state (joined / needs_user / failed) ya bound na aaye.
 *  2. v1 ka isJoined page-wide "joined" text pe true ho jata tha (galat positive).
 *     v2 me access signals campaign/rewards context me scope hote hain.
 *  3. v1 me click fingerprint text-based tha (quotes/truncation se toot sakta tha).
 *     v2 me numeric index fingerprint hai — toot-ta nahi.
 *  4. v1 me wahi element baar-baar tap ho sakta tha (loop). v2 tapped elements
 *     track karta hai aur state na badle to next-best candidate try karta hai.
 *  5. Har iteration ki soch (perception → decision → action → result) trail me
 *     record hoti hai — Live page pe user dekh sakta hai agent ne kya socha.
 *
 * Koi fixed position tapping nahi — sirf semantic element (index fingerprint).
 * Payment/subscription kabhi auto nahi — needs_user.
 */
object AgentBrain {

    /** Agent loop ke terminal nateeje. */
    enum class AgentOutcome { JOINED, NEEDS_USER, FAILED }

    /** Ek iteration ki soch — Live page pe dikhane ke liye. */
    data class AgentStep(
        val iter: Int,
        val pageType: String,
        val decision: String,
        val action: String,
        val result: String,
    )

    // ------------------------------------------------------------------
    // KNOWLEDGE PACK — har DECIDE step pe consult + rule-ID citation
    // ------------------------------------------------------------------
    private val knowledgeRules = mutableMapOf<String, String>() // id -> "title — text"
    private var knowledgeVersion = "?"
    private var knowledgeLoaded = false

    /**
     * Bundled asset (`assets/agent_knowledge.json`) init pe load karo.
     * Idempotent — pehli successful load ke baad dobara nahi.
     */
    fun initKnowledge(appContext: Context) {
        if (knowledgeLoaded) return
        try {
            val raw = appContext.assets.open("agent_knowledge.json")
                .bufferedReader().readText()
            applyKnowledgeJson(raw)
            knowledgeLoaded = knowledgeRules.isNotEmpty()
        } catch (_: Exception) { /* loaded=false — decide fail-closed karega */ }
    }

    /**
     * Server knowledge push: memory-sync se aayi `knowledge.*` lessons
     * (content: {id, title, text}) bina APK ke merge karo. Existing IDs
     * override hote hain — server hamesha jeetta hai.
     */
    fun applyKnowledgeUpdate(json: String) {
        try { applyKnowledgeJson(json) } catch (_: Exception) { }
    }

    private fun applyKnowledgeJson(raw: String) {
        val o = JSONObject(raw)
        if (o.has("version")) knowledgeVersion = o.optString("version", knowledgeVersion)
        val arr = o.optJSONArray("rules") ?: return
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val id = r.optString("id", "")
            if (id.isNotEmpty()) {
                knowledgeRules[id] =
                    r.optString("title", "").take(120) + " — " + r.optString("text", "").take(400)
            }
        }
    }

    /**
     * Har DECIDE step pe consult: cited rule IDs pack me hone chahiye.
     * Pack missing ya rule unknown → fail-closed marker (decide ise terminal
     * FAILED me badal deta hai — andhere me act nahi).
     */
    private fun cite(vararg ids: String): String {
        if (!knowledgeLoaded || knowledgeRules.isEmpty())
            return "[knowledge: UNAVAILABLE — fail-closed]"
        val missing = ids.filter { it !in knowledgeRules }
        return if (missing.isEmpty()) "[knowledge: ${ids.joinToString(", ")}]"
        else "[knowledge: MISSING_RULES(${missing.joinToString(",")}) — fail-closed]"
    }

    private fun knowledgeOk(citation: String): Boolean =
        !citation.contains("fail-closed")

    data class AgentResult(
        val outcome: AgentOutcome,
        val detail: String,
        val trail: List<AgentStep>,
    )

    /** Perceive kiya hua ek interactive element. */
    data class UIElement(
        val index: Int,
        val text: String,
        val role: String,
        val hasLockIcon: Boolean,
        val isDisabled: Boolean,
        val looksLikePrice: Boolean,
        val inModal: Boolean,
        val semanticAction: String, // unlock_rewards | join_free | open_rewards | checkout_pay | navigate | unknown
        val confidence: Float,
    )

    /** Page ki samajh. */
    data class PageUnderstanding(
        val pageType: String,      // community_home | campaign_page | checkout | login | rewards_dashboard | modal | unknown
        val isJoined: Boolean,     // scoped access signals
        val isLoginRequired: Boolean,
        val isPaymentRequired: Boolean,
        val isRegionBlocked: Boolean, // p41: "not available in your region" jaisa geo block
        val url: String,
        val elements: List<UIElement>,
        val accessSummary: String,
    )

    // ------------------------------------------------------------------
    // Public entry: bounded multi-screen agent loop
    // ------------------------------------------------------------------
    /**
     * Join agent chalao.
     *
     * @param js WebView me JS eval karne wala suspend lambda (JobEngine::jsStr).
     * @param goal "community_join" (brand community / Content Rewards access)
     *             ya "campaign_join" (specific campaign ka member banna).
     * @param maxIters zyada se zyada perceive→act cycles (default 10).
     * @param deadlineMs poore loop ki deadline.
     * @param onThought har iteration pe heartbeat/step ke liye callback.
     */
    suspend fun runJoinAgent(
        js: suspend (String) -> String?,
        goal: String,
        maxIters: Int = 10,
        deadlineMs: Long = 6 * 60_000L,
        onThought: (iter: Int, thought: String) -> Unit = { _, _ -> },
        /** WebView renderer mar gaya to loop turant roko (fail-closed). */
        isDead: () -> Boolean = { false },
    ): AgentResult {
        val trail = mutableListOf<AgentStep>()
        // p42 FIX (2026-09-20): tapped identity ab "index:url" NAHI — semantic
        // fingerprint hai: "semanticAction:normalizedText:urlBase". Index har
        // perceive me shift ho sakta tha (fragile), aur sabse bada bug: ek
        // ineffective tap ke baad button HAMESHA ke liye exclude ho jata tha →
        // agle iteration me FAILED_NO_ACTION (user ka screenshot wala case:
        // "Join Campaign" dikh raha hai, tap nahi ho raha).
        // Ab: fingerprint → tap count. Page/state NA badle to SAME element ko
        // max 2 baar retry (dusri baar strong click), uske baad hi dead.
        val tapped = mutableMapOf<String, Int>() // fingerprint -> tap count
        val dead = mutableSetOf<String>() // 2 ineffective taps → dobara nahi
        val deadline = System.currentTimeMillis() + deadlineMs
        var lastUrl = ""
        var lastSig = "" // page signature — state badla ya nahi, ye dekhne ke liye

        var iter = 0
        while (iter < maxIters && System.currentTimeMillis() < deadline) {
            iter++
            // renderer dead = aage badhna bekaar — turant fail-closed
            if (try { isDead() } catch (_: Exception) { false }) {
                return AgentResult(
                    AgentOutcome.FAILED,
                    "Brain: WebView renderer dead — join adhura raha",
                    trail
                )
            }
            // ---- PERCEIVE ----
            val p = perceive(js)
            val sig = pageSignature(p)
            val pageChanged = p.url != lastUrl || sig != lastSig
            lastUrl = p.url
            lastSig = sig

            // ---- DECIDE ----
            val (terminal, actionDesc, target) = decide(goal, p, tapped, dead, pageChanged)
            if (terminal != null) {
                val step = AgentStep(iter, p.pageType,
                    decision = terminal.first, action = "—", result = terminal.second)
                trail.add(step)
                onThought(iter, "brain: ${terminal.first} — ${terminal.second.take(80)}")
                return AgentResult(terminalOutcome(terminal.first), terminal.second, trail)
            }

            // ---- ACT ----
            // p42: retry strategy — pehla tap normal click, page NA badle to
            // dusra tap "strong" (real MouseEvents: mousedown/mouseup/click —
            // kuch frameworks sirf el.click() pe react nahi karte).
            val fp = fingerprint(target!!, p.url)
            val tries = tapped.getOrDefault(fp, 0)
            val strong = tries >= 1
            val thought = "$actionDesc → '${target.text.take(40)}'" +
                if (strong) " (retry#${tries + 1}, strong click)" else ""
            onThought(iter, "brain: $thought")
            val tappedOk = tapElement(js, target.index, strong)
            delayMs(if (strong) 3500 else 2200)
            // action ke baad dobara perceive taaki naya screen samajh aaye
            val p2 = perceive(js)
            val sig2 = pageSignature(p2)
            val changed = p2.url != p.url || sig2 != sig
            if (!tappedOk) {
                trail.add(AgentStep(iter, p.pageType, thought, "tap idx=${target.index}",
                    "TAP_MISS: element DOM me nahi mila — agle perceive me naya decision"))
                // element gayab: fingerprint dead nahi (page hi badal gaya hoga)
            } else {
                tapped[fp] = tries + 1
                lastUrl = p2.url
                lastSig = sig2
                // p42: post-tap diagnosis — button abhi bhi wahi hai ya nahi?
                val stillThere = p2.elements.any {
                    fingerprint(it, p2.url) == fp && !it.isDisabled
                }
                val diag = when {
                    changed -> "page/state badla — aage sochenge"
                    tries + 1 >= 2 -> {
                        dead.add(fp)
                        "2 taps, koi badlav nahi — button be-asar (dead). " +
                            if (stillThere) "Button abhi bhi dikh raha hai lekin react nahi karta." else "Button gayab ho gaya."
                    }
                    else -> "koi badlav nahi — ek baar strong click se retry karenge" +
                        if (stillThere) " (button abhi bhi maujood hai)" else ""
                }
                trail.add(AgentStep(iter, p.pageType, thought, "tap idx=${target.index}", diag))
            }
        }

        val reason = if (System.currentTimeMillis() >= deadline)
            "time khatam ($maxIters iterations / deadline) — join adhura raha"
        else
            "iteration bound khatam — join adhura raha"
        trail.add(AgentStep(iter, "—", "BOUND_HIT", "—", reason))
        return AgentResult(AgentOutcome.FAILED, "Brain: $reason. Trail: " +
            trail.takeLast(3).joinToString(" | ") { it.decision }, trail)
    }

    private fun terminalOutcome(tag: String): AgentOutcome = when {
        tag.startsWith("JOINED") -> AgentOutcome.JOINED
        tag.startsWith("NEEDS_USER") -> AgentOutcome.NEEDS_USER
        else -> AgentOutcome.FAILED
    }

    private suspend fun delayMs(ms: Long) {
        try { kotlinx.coroutines.delay(ms) } catch (_: Exception) { }
    }

    // ------------------------------------------------------------------
    // PERCEIVE
    // ------------------------------------------------------------------
    suspend fun perceive(js: suspend (String) -> String?): PageUnderstanding {
        val raw = try { js(JS_SEMANTIC_SCAN) } catch (_: Exception) { null } ?: "{}"
        val snap = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
        val elements = mutableListOf<UIElement>()
        val arr = snap.optJSONArray("elements")
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                elements.add(UIElement(
                    index = e.optInt("idx", i),
                    text = e.optString("text", "").take(120),
                    role = e.optString("role", ""),
                    hasLockIcon = e.optBoolean("hasLock", false),
                    isDisabled = e.optBoolean("disabled", false),
                    looksLikePrice = e.optBoolean("hasPrice", false),
                    inModal = e.optBoolean("inModal", false),
                    semanticAction = e.optString("semantic", "unknown"),
                    confidence = e.optDouble("confidence", 0.0).toFloat(),
                ))
            }
        }
        return PageUnderstanding(
            pageType = snap.optString("pageType", "unknown"),
            isJoined = snap.optBoolean("isJoined", false),
            isLoginRequired = snap.optBoolean("isLoginRequired", false),
            isPaymentRequired = snap.optBoolean("isPaymentRequired", false),
            isRegionBlocked = snap.optBoolean("isRegionBlocked", false),
            url = snap.optString("url", ""),
            elements = elements,
            accessSummary = snap.optString("accessSummary", ""),
        ).also { noteSession(it) }
    }

    // ------------------------------------------------------------------
    // WebView session signals (2026-09-20 WP3)
    // ------------------------------------------------------------------
    /**
     * Phone ne kabhi authenticated IG/Whop page dekha? — ye flags
     * AutomationWorker heartbeat me server ko jate hain
     * (devices.ig/whop_session_ok_at), taaki server brain upload/submit
     * se pehle session freshness verify kar sake.
     * Sirf boolean flags — koi cookie/token kahin nahi jata.
     */
    @Volatile private var igSessionSeen = false
    @Volatile private var whopSessionSeen = false

    private fun noteSession(p: PageUnderstanding) {
        if (p.isLoginRequired) return // login page = session signal NAHI
        val u = p.url.lowercase()
        if ("instagram.com" in u) igSessionSeen = true
        if ("whop.com" in u || "contentrewards" in u) whopSessionSeen = true
    }

    /** Server heartbeat ke liye: {ig: true/false, whop: true/false}. */
    fun sessionSignals(): Map<String, Boolean> =
        mapOf("ig" to igSessionSeen, "whop" to whopSessionSeen)

    /** Page state ka chhota fingerprint — badlav detect karne ke liye. */
    private fun pageSignature(p: PageUnderstanding): String {
        val top = p.elements.take(12).joinToString("|") { "${it.text.take(20)}:${it.hasLockIcon}" }
        return "${p.pageType}#${p.isJoined}#${top.hashCode()}"
    }

    /**
     * Semantic fingerprint — perceive ke beech index shift ho jaye to bhi
     * wahi element pehchana jaye. Text normalize (lowercase, extra space
     * collapse) + semantic action + URL base.
     */
    private fun fingerprint(e: UIElement, url: String): String {
        val normText = e.text.lowercase().replace(Regex("\\s+"), " ").trim().take(40)
        val base = url.substringBefore("?").substringBefore("#")
        return "${e.semanticAction}:$normText:$base"
    }

    // ------------------------------------------------------------------
    // DECIDE — goal + page state → terminal ya tap target
    // ------------------------------------------------------------------
    /**
     * Returns: Triple(terminalPair?, actionDesc, targetElement?)
     * terminalPair = (TAG, detail) — TAG: JOINED_* | NEEDS_USER_* | FAILED_*
     */
    private fun decide(
        goal: String,
        p: PageUnderstanding,
        tapped: Map<String, Int>,
        dead: Set<String>,
        pageChanged: Boolean,
    ): Triple<Pair<String, String>?, String, UIElement?> {
        // KNOWLEDGE CONSULT — har DECIDE step pe: pack load nahi hua to
        // andhere me act nahi karenge (fail-closed).
        if (!knowledgeLoaded || knowledgeRules.isEmpty()) {
            return Triple("FAILED_NO_KNOWLEDGE" to
                "knowledge pack load nahi hua [knowledge: UNAVAILABLE — fail-closed] — " +
                "bina rules ke act nahi karenge", "", null)
        }
        if (goal != "community_join" && goal != "campaign_join") {
            val c = cite("core-loop.R1")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "goal '$goal' brain nahi samajhta $c", "", null)
            return Triple("FAILED_UNKNOWN_GOAL" to "goal '$goal' brain nahi samajhta $c", "", null)
        }

        // 1. Login chahiye → user khud karega
        if (p.isLoginRequired) {
            val c = cite("compliance-guard.R2")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "login required, lekin rule verify nahi hua $c", "", null)
            return Triple("NEEDS_USER_LOGIN" to
                "page login mang raha hai — user ko app me Whop dobara login karna hoga $c", "", null)
        }
        // 2. Pehle se access → kaam ho gaya
        if (p.isJoined) {
            val c = cite("core-loop.R4", "campaign-scout.R7")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "joined lag raha hai, lekin rule verify nahi hua $c", "", null)
            return Triple("JOINED_ALREADY" to
                "page pe scoped access signals mile (${p.accessSummary}) — pehle se joined $c", "", null)
        }
        // 3. Payment/subscription → user decide karega, AUTO-BUY KABHI NAHI
        if (p.isPaymentRequired) {
            val c = cite("compliance-guard.R1")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "payment signal, lekin rule verify nahi hua $c", "", null)
            return Triple("NEEDS_USER_PAYMENT" to
                "join ke liye payment/subscription mang raha hai — user khud decide kare (auto-buy nahi) $c", "", null)
        }

        // 3b. p41: Region/geo block — USA egress (main-frame + XHR proxy) ke
        // baad bhi "not available in your region" dikhe to proxy fail hua hai.
        // Andha click nahi — honest terminal fail (issue escalation hoga).
        if (p.isRegionBlocked) {
            val c = cite("campaign-scout.R10", "core-loop.R5")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "region block dikha, lekin rule verify nahi hua $c", "", null)
            return Triple("FAILED_REGION_BLOCKED" to
                "page region-blocked hai ('not available in your region') — USA egress " +
                "se bhi bypass nahi hua. Proxy/route check karke retry karo $c", "", null)
        }

        // Candidates — 2 ineffective taps ke baad dead (dobara nahi);
        // warna fingerprint pehle tap ke baad bhi retry ke liye available
        // (p42: ek be-asar tap = turant FAILED_NO_ACTION wala bug fix).
        fun fresh(list: List<UIElement>): List<UIElement> =
            list.filter { fingerprint(it, p.url) !in dead }

        // 4. LOCKED "Content Rewards" — user ke screenshot wala darwaza.
        //    Modal ke andar ho to use prefer karo (lock tap ke baad khula modal).
        val locked = fresh(p.elements
            .filter { it.hasLockIcon && !it.isDisabled }
            .sortedWith(compareByDescending<UIElement> { it.inModal }
                .thenByDescending { it.confidence }))
        if (locked.isNotEmpty()) {
            val t = locked.first()
            val c = cite("campaign-scout.R5")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "lock dikha, lekin rule verify nahi hua $c", "", null)
            return Triple(null, "LOCKED_REWARDS $c: lock wala element tap karke unlock karenge", t)
        }

        // 5. Free "Join" button (bina price ke)
        val joinFree = fresh(p.elements
            .filter { it.semanticAction == "join_free" && !it.isDisabled && !it.looksLikePrice }
            .sortedWith(compareByDescending<UIElement> { it.inModal }
                .thenByDescending { it.confidence }))
        if (joinFree.isNotEmpty()) {
            val t = joinFree.first()
            val c = cite("campaign-scout.R6", "compliance-guard.R1")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "free join dikha, lekin rule verify nahi hua $c", "", null)
            return Triple(null, "JOIN_BUTTON $c: free join lag raha hai", t)
        }

        // 6. "Content Rewards" section khula hua (bina lock) — andar join dhoondho
        val openRewards = fresh(p.elements
            .filter { it.semanticAction == "open_rewards" && !it.isDisabled }
            .sortedByDescending { it.confidence })
        if (openRewards.isNotEmpty()) {
            val t = openRewards.first()
            val c = cite("campaign-scout.R7")
            if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
                "rewards section dikha, lekin rule verify nahi hua $c", "", null)
            return Triple(null, "REWARDS_SECTION $c: khol ke andar join option dhoondhenge", t)
        }

        // 7. Sab candidates dead ya koi nahi — agar page badla tha to
        //    ek baar phir perceive karne do (caller loop karega); nahi badla to honest fail.
        val seen = p.elements.take(5).joinToString(", ") { "'${it.text.take(30)}'" }
        // p42: kya try hua tha, wo bhi detail me — Live pe "arbitrary" na lage
        val tried = if (tapped.isEmpty()) "kuch try nahi hua"
        else tapped.entries.joinToString("; ") { (fp, n) ->
            val short = fp.substringBefore(":") + " '" + fp.substringAfter(":").substringBeforeLast(":").take(25) + "'"
            "$short x$n" + if (fp in dead) " (be-asar)" else ""
        }
        val c = cite("core-loop.R6", "core-loop.R2")
        if (!knowledgeOk(c)) return Triple("FAILED_NO_KNOWLEDGE" to
            "koi rasta nahi, lekin rule verify nahi hua $c", "", null)
        return Triple("FAILED_NO_ACTION" to
            "goal '$goal': page type '${p.pageType}' pe join ka rasta nahi mila $c. " +
            "Dikhe: $seen. Try kiya: $tried. Robot ki tarah andha click nahi karenge.", "", null)
    }

    // ------------------------------------------------------------------
    // ACT — index fingerprint se tap (text-substitution ki fragility nahi)
    // ------------------------------------------------------------------
    /**
     * @param strong false = normal el.click(); true = real MouseEvents
     * (mousedown→mouseup→click) — kuch frameworks sirf el.click() pe react
     * nahi karte, unhe trusted-jaise events chahiye (p42 retry strategy).
     */
    suspend fun tapElement(js: suspend (String) -> String?, index: Int, strong: Boolean = false): Boolean {
        val clickJs = (if (strong) JS_BRAIN_CLICK_STRONG else JS_BRAIN_CLICK)
            .replace("BRAIN_IDX", index.toString())
        return try {
            val r = js(clickJs)?.trim()
            r == "true" || r == "1"
        } catch (_: Exception) { false }
    }

    // ------------------------------------------------------------------
    // JS: semantic scan v2
    // ------------------------------------------------------------------
    val JS_SEMANTIC_SCAN = """
        (function(){
          var url = location.href || '';
          var body = document.body;
          var t = (body ? body.innerText : '') || '';
          var tl = t.toLowerCase();

          // ---- modal? (lock tap ke baad khulne wala dialog) ----
          var modal = document.querySelector('[role="dialog"], [role="alertdialog"], .modal, [data-state="open"]');

          // ---- page type ----
          var pageType = 'unknown';
          if (modal) pageType = 'modal';
          else if (/\/login|\/auth|\/signin/i.test(url) || /log in to whop|sign in to continue/i.test(t)) pageType = 'login';
          else if (/checkout|complete purchase|payment method/i.test(tl) && /[$₹]\s*\d/.test(t)) pageType = 'checkout';
          else if (/content rewards|rewards dashboard|your earnings/i.test(tl)) pageType = 'rewards_dashboard';
          else if (/discover\/|campaign/i.test(url)) pageType = 'campaign_page';
          else if (/whop\.com\//i.test(url)) pageType = 'community_home';

          // ---- scoped access signals (v2: generic "joined" text nahi ginta) ----
          var accessHits = [];
          var pats = [
            /you're in\b/i, /\byou joined this\b/i, /manage membership/i,
            /submit your clip/i, /upload your (clip|video)/i, /your earnings/i,
            /my dashboard/i, /welcome back/i, /create (a )?submission/i
          ];
          for (var pi = 0; pi < pats.length; pi++) {
            var m = t.match(pats[pi]);
            if (m) accessHits.push(m[0].slice(0, 40));
          }
          // generic "N people joined" jaisi unrelated lines ko bahar rakho:
          // access tabhi jab page campaign/community/rewards context me ho
          var inScope = /community_home|campaign_page|rewards_dashboard|modal/.test(pageType);
          var isJoined = inScope && accessHits.length > 0;

          var isLoginRequired = pageType === 'login';
          var isPaymentRequired = pageType === 'checkout' ||
            (/[$₹]\s*\d/.test(t) && /per month|\/month|\/mo\b|subscribe|buy now|complete purchase/i.test(tl));

          // p41: region/geo block — USA egress ke baad bhi ye dikhe to
          // proxy fail hua hai; brain andha click nahi karega, honest fail.
          var isRegionBlocked = /not available in your (region|country)|unavailable in your region|isn'?t available in your region|region.?restricted|geo.?blocked/i.test(tl);

          // ---- elements (numeric index fingerprint — text fragile nahi) ----
          var scope = modal || document;
          var els = [...scope.querySelectorAll('button, a, [role="button"], [role="link"], [onclick]')];
          var out = [];
          var seen = new Set();
          var idx = 0;
          for (var e of els) {
            if (!e.isConnected) continue;
            var r = e.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            var txt = ((e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 120);
            if (!txt || seen.has(txt)) continue;
            seen.add(txt);
            var cls = (e.className && e.className.baseVal !== undefined ? e.className.baseVal : (e.className || '')) + '';
            var html = '';
            try { html = e.outerHTML.slice(0, 2500).toLowerCase(); } catch(_){}
            var aria = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase();

            // lock detection v2: class, emoji, svg lock, aria-label, surrounding text
            var svgLock = /lock/.test(html) && /<svg/i.test(html);
            var hasLock = /lock/i.test(cls) || /🔒|🔐/.test(txt) || svgLock ||
              /lock/.test(aria) || /\blocked\b/i.test(txt);

            var disabled = e.disabled === true || /disabled/i.test(cls) ||
              e.getAttribute('aria-disabled') === 'true';

            var hasPrice = /[$₹]\s*\d/.test(txt) || /\/month|\/mo\b/i.test(txt);

            var inModal = modal ? modal.contains(e) : false;

            // semantic classification
            var tll = txt.toLowerCase();
            var semantic = 'unknown', confidence = 0.3;
            if (/content rewards/i.test(txt)) {
              if (hasLock) { semantic = 'unlock_rewards'; confidence = 0.95; }
              else { semantic = 'open_rewards'; confidence = 0.8; }
            } else if (/^(join|join now|join campaign|join the campaign|join program|get access)$/i.test(tll)) {
              if (hasPrice || isPaymentRequired) { semantic = 'checkout_pay'; confidence = 0.9; }
              else { semantic = 'join_free'; confidence = 0.85; }
            } else if (/join/i.test(tll) && !hasPrice) {
              semantic = 'join_free'; confidence = 0.6;
            } else if (/^(apply|apply now|enroll|get started|become a creator|start earning|start clipping)$/i.test(tll) && !hasPrice) {
              // p42: CTA text variants — kuch campaigns "Join" nahi likhte
              // ("Apply", "Get started"...). Confidence kam, taaki exact
              // "Join Campaign" match hamesha jeete; galat tap bhi bounded
              // hai (max 2 taps, phir dead) aur login/payment check pehle
              // ho chuka hai.
              semantic = 'join_free'; confidence = 0.5;
            } else if (/subscribe|buy now|complete purchase|checkout/i.test(tll)) {
              semantic = 'checkout_pay'; confidence = 0.9;
            } else if (/^continue$|^next$|^submit$/i.test(tll)) {
              semantic = 'navigate'; confidence = 0.5;
            }

            e.setAttribute('data-brain-idx', String(idx));
            out.push({idx: idx, text: txt, role: (e.tagName || '').toLowerCase(),
              hasLock: hasLock, disabled: disabled, hasPrice: hasPrice,
              inModal: inModal, semantic: semantic, confidence: confidence});
            idx++;
            if (out.length >= 40) break;
          }
          return JSON.stringify({url: url, pageType: pageType, isJoined: isJoined,
            isLoginRequired: isLoginRequired, isPaymentRequired: isPaymentRequired,
            isRegionBlocked: isRegionBlocked,
            accessSummary: accessHits.slice(0,3).join(' / '), elements: out});
        })()
    """.trimIndent()

    /** Index se tap — koi text substitution nahi, isliye fragile nahi. */
    val JS_BRAIN_CLICK = """
        (function(){
          var el = document.querySelector('[data-brain-idx="BRAIN_IDX"]');
          if (!el) {
            var all = document.querySelectorAll('[data-brain-idx]');
            if (BRAIN_IDX < all.length) el = all[BRAIN_IDX];
          }
          if (!el) return false;
          try { el.scrollIntoView({block: 'center'}); } catch(e){}
          try { el.click(); } catch(e){ return false; }
          return true;
        })()
    """.trimIndent()

    /**
     * p42: strong click — real MouseEvents (mousedown→mouseup→click).
     * Kuch frameworks/synthetic handlers sirf el.click() pe react nahi
     * karte; unhe trusted-jaise event sequence chahiye. Retry#2 me use hota hai.
     */
    val JS_BRAIN_CLICK_STRONG = """
        (function(){
          var el = document.querySelector('[data-brain-idx="BRAIN_IDX"]');
          if (!el) {
            var all = document.querySelectorAll('[data-brain-idx]');
            if (BRAIN_IDX < all.length) el = all[BRAIN_IDX];
          }
          if (!el) return false;
          try { el.scrollIntoView({block: 'center'}); } catch(e){}
          try {
            var r = el.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var opts = {bubbles: true, cancelable: true, view: window,
                        clientX: cx, clientY: cy, button: 0};
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
          } catch(e){ return false; }
          return true;
        })()
    """.trimIndent()
}
