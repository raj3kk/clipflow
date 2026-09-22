package com.clipflow.agent.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Job spec (JSON steps) ko hidden WebView me execute karta hai.
 * ARCHITECTURE.md §3.4 ka format.
 *
 * Actions: download, navigate, click, type, upload, wait_url, wait_text,
 *          wait_js, eval, extract, assert, screenshot
 * Selector: {"by":"css"|"text"|"aria", "value":"..."}
 * "{{var}}" placeholders pichle extract steps se bhare jate hain.
 * "assert": {"js":"...","message":"..."} — JS truthy nahi to fail (message ke saath).
 * "optional": true — step fail ho to warning note karke aage badho (best-effort verify).
 *
 * p18 STALL SAFETY: job beech me atke (WebView renderer crash, page load hang,
 * network stall) to chup-chaap atka NAHI rahega —
 *  - renderer crash → onRenderProcessGone me flag, agle step pe fail
 *    (app crash NAHI hogi — default behavior app ko maarta hai)
 *  - har navigate pe 60s page-load timeout
 *  - poore job pe 20-min deadline (step boundary pe check — coroutine
 *    cancellation ka mess nahi, seedha Exception → fail-mark + server report)
 *  - onStep callback: caller (worker) har step pe progress record kar sakta hai
 * Round-7 (Worker A) additions:
 *  - onStepEnd callback: har step ke KHATAM hone pe bhi (success/fail) —
 *    step fail turant server heartbeat pe jata hai
 *  - per-step stall watchdog: pichla step complete hue 10 min se zyada →
 *    fail-mark (koi step infinite hang nahi)
 *  - js eval pe 30s timeout (callback kabhi na aaye to hang nahi)
 *  - upload: chooser-served flag har upload se pehle reset (doosra upload
 *    wait skip na kare)
 */
class JobEngine(
    private val context: Context,
    private val webView: WebView,
    private val workDir: File,
    private val onStep: ((stepIndex: Int, totalSteps: Int, action: String) -> Unit)? = null,
    /**
     * Round-7 (Worker A): har step ke KHATAM hone pe bhi callback —
     * success ho ya failure. Caller (worker) isse server ko heartbeat
     * bhejta hai taaki step fail turant Live page pe dikhe, na ki
     * poore job ke fail hone ka wait ho.
     */
    private val onStepEnd: ((stepIndex: Int, totalSteps: Int, action: String, ok: Boolean, error: String?) -> Unit)? = null,
    /**
     * LIVE PREVIEW (2026-09-20): job chalte hue har 15 sec me screenshot
     * server ko bhejta hai taaki web Live page pe dikhe phone kya kar raha hai.
     */
    private val reporter: Reporter? = null,
    /**
     * p39: server brain se aaye semantic lessons (job start pe pull hue).
     * Brain phases inhe vars me dekh sakta hai — Live page pe bhi dikhte hain.
     */
    private val serverLessons: String? = null,
    /**
     * p39: AgentBrain terminal FAILED ho to escalation hook — caller
     * (AutomationWorker) isse server pe agent_issue file karta hai taaki
     * assistant root-cause fix kar sake. Best-effort, kabhi throw nahi karna.
     */
    private val onBrainFailed: ((label: String, detail: String) -> Unit)? = null,
    /**
     * p39-knowledge: memory-sync se aayi `knowledge.*` lessons ka JSON
     * ({version, rules:[{id,title,text}]}) — bundled asset ke upar merge
     * hota hai, bina APK ke. Null = koi server update nahi.
     */
    private val serverKnowledgeUpdates: String? = null,
) {
    // p41: ConcurrentHashMap — vars ko Main coroutine ke saath-saath
    // shouldInterceptRequest (WebView background thread) bhi likhta hai.
    private val vars = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val shotsDir = File(workDir, "shots").apply { mkdirs() }
    private val filesDir = File(workDir, "files").apply { mkdirs() }
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()
    private val chrome = AutomationChromeClient()
    /**
     * p41: USA egress bridge ka shared instance — JS fetch/XHR interceptor
     * (__usProxy) aur main-frame document intercept (shouldInterceptRequest)
     * dono isi se proxy karte hain. Cookie sync (WebView ↔ egress) bridge
     * ke andar hota hai, isliye session bana rehta hai.
     * p43: store shared — usaProxyEnabled() toggle dono jagah gate karta hai.
     */
    private val store = com.clipflow.agent.data.DeviceStore(context)
    private val egressBridge =
        com.clipflow.agent.net.UsEgressBridge(store)

    data class RunResult(
        val ok: Boolean,
        val vars: Map<String, String>,
        val screenshots: List<File>,
        val error: String? = null,
    )

    init {
        // file upload ke liye chooser auto-answer
        webView.webChromeClient = chrome
        // p39-knowledge: AgentBrain ka knowledge pack init pe load karo —
        // training = knowledge injection (weights retrain nahi hote).
        // Best-effort: fail ho to brain har DECIDE pe fail-closed rahega.
        try {
            AgentBrain.initKnowledge(context)
            val upd = serverKnowledgeUpdates
            if (!upd.isNullOrBlank()) AgentBrain.applyKnowledgeUpdate(upd)
        } catch (_: Exception) { }
        // p35/p41: USA egress bridge — whop.com/contentrewards.com ke requests
        // Vercel (Virginia, USA) se proxy hote hain taaki region-locked
        // campaigns ("not available in your region") join ho saken.
        // p41: sirf fetch/XHR nahi — MAIN-FRAME document loads bhi US IP se
        // (shouldInterceptRequest neeche), kyunki region lock aksar page ke
        // document load pe hi lagta hai; andar ka XHR intercept kaafi nahi tha.
        try {
            webView.addJavascriptInterface(egressBridge, "__usProxy")
        } catch (_: Exception) { /* bridge na lage to proxy skip — direct */ }
    }

    /**
     * p18: WebView renderer (tab) crash ka flag. onRenderProcessGone default
     * me app process ko maar deta hai — hum return true karke khud sambhalte
     * hain taaki job fail-mark ho kar server ko report ho (chup-chaap atakna
     * ya app crash dono se behtar).
     */
    @Volatile
    var rendererCrashed: Boolean = false
        private set

    companion object {
        /** Poore job ki deadline — isse zyada atka to fail-mark (stall safety). */
        const val JOB_TIMEOUT_MS = 20 * 60_000L
        /** Ek page load ka max wait — iske baad fail (hang nahi). */
        const val PAGE_LOAD_TIMEOUT_MS = 5 * 60_000L
        /** Ek JS eval ka max wait — callback kabhi na aaye (renderer dead,
         *  JS context toota) to 30s me fail, hamesha ke liye hang nahi. */
        const val JS_EVAL_TIMEOUT_MS = 30_000L
        /**
         * Round-7 (Worker A): PER-STEP STALL WATCHDOG. Peechla step complete
         * hue isse zyada ho gaya aur naya step abhi tak khatam nahi hua to
         * job fail-mark (silent dead nahi rahega). Har step waise bhi
         * bounded hai (navigate 60s, js eval 30s, wait_url/wait_text apna
         * timeout, download socket timeout) — 10 min ka matlab pakka atakna.
         */
        const val STEP_TIMEOUT_MS = 10 * 60_000L
        /** Poore join flow ki deadline — join chhota kaam hai, 8 min kaafi. */
        const val JOIN_TIMEOUT_MS = 8 * 60_000L
        /** Poore verify flow ki deadline — 3 candidates × page+join, 12 min kaafi. */
        const val VERIFY_TIMEOUT_MS = 12 * 60_000L
        /** Poore discover flow ki deadline — hub page + scroll + extract. */
        const val DISCOVER_TIMEOUT_MS = 8 * 60_000L
        /** Join tap ke baad confirmation ka max wait. */
        const val JOIN_CONFIRM_TIMEOUT_MS = 15_000L
        /**
         * Browser Agent v1 (2026-09-21): live_session job ki max zindagi.
         * Admin kabhi stop na kare to bhi 30 min me loop band (battery/net).
         */
        const val LIVE_SESSION_TIMEOUT_MS = 30 * 60_000L
        /** Live session ka frame cadence (~10s — design doc §3.4). */
        const val LIVE_SESSION_CADENCE_MS = 10_000L
    }

    /**
     * join_campaign job ka dedicated handler (Round-7, 2026-09-19).
     * Server payload: { campaign_url, campaign_slug }.
     *
     * Phone ka WebView Whop me LOGGED-IN hai (user ne app me Whop login kiya
     * tha; cookies CookieManager me persist rehte hain — LoginWebView ka
     * comment dekho). Flow: campaign page kholo → login check →
     * already-joined check → Join button dhoondho + tap karo → 15s me
     * confirmation check → screenshot proof.
     *
     * Result vars: join_status = joined | already_joined | needs_user | failed,
     * join_detail (Hinglish). needs_user = login expire / extra verification
     * (IG connect, captcha, checkout) — user ka action chahiye; server ispe
     * campaigns.join_status='needs_user' set karta hai aur retry NAHI karta.
     *
     * Stall safety: loadUrl ka 60s timeout + renderer-crash flag (p18/p19 code
     * reuse) + poore join pe 8-min deadline. Har phase pe onStep → caller
     * heartbeat/progress bhejta hai (AutomationWorker).
     */
    suspend fun runJoinCampaign(job: JSONObject): RunResult = withContext(Dispatchers.Main) {
        val shots = mutableListOf<File>()
        // p35 FIX: live preview — pehle join me preview nahi tha, isliye
        // Live page pe stale (Instagram home) screenshot dikhta tha.
        val previewJob = startLivePreview(this)
        // Local phase helpers try/catch dono me visible hone chahiye — isliye try se PEHLE.
        var lastPhase = -1
        var lastAction = ""
        fun endPhase(ok: Boolean, error: String?) {
            if (lastPhase < 0) return
            try {
                onStepEnd?.invoke(lastPhase, 7, lastAction, ok, error)
            } catch (_: Exception) { }
        }
        try {
            // p39: server brain ka directive (goal + constraints) — scripted taps
            // nahi, sirf goal-level nirdesh. Brain inhe apne decide() me use karega.
            val directive = job.optJSONObject("directive")
            val directiveGoal = directive?.optString("goal", "")?.trim().orEmpty()
            val directiveConstraints = directive?.optString("constraints", "")?.trim().orEmpty()
            if (directiveGoal.isNotEmpty()) vars["directive_goal"] = directiveGoal.take(80)
            if (directiveConstraints.isNotEmpty()) vars["directive_constraints"] = directiveConstraints.take(300)
            // p39: job start pe server se pull hue semantic lessons — brain ke
            // paas pichle runs ka seekha hua gyaan. Live page pe bhi dikhta hai.
            serverLessons?.take(1500)?.let { vars["memory_lessons"] = it }
            val url = job.optString("campaign_url", "").trim()
            val slug = job.optString("campaign_slug", "")
            // 2026-09-20: brand ka Whop community URL — campaign join se PEHLE
            // iska member banna padta hai (FundingPips flow: free Join button).
            // Ye step pehle missing tha — sirf campaign_url khulta tha.
            val whopUrl = job.optString("whop_url", "").trim()
            if (url.isEmpty()) throw JoinOutcome(
                "failed",
                "campaign_url missing — server ne join page ka URL nahi diya"
            )
            vars["campaign_slug"] = slug
            val deadline = System.currentTimeMillis() + JOIN_TIMEOUT_MS

            fun guard() {
                if (rendererCrashed) throw JoinOutcome(
                    "failed",
                    "WebView renderer crash ho gaya (tab crash) — job fail-mark ki gayi"
                )
                if (System.currentTimeMillis() > deadline) throw JoinOutcome(
                    "failed",
                    "join timeout: 8 min se zyada laga — fail-mark kiya gaya"
                )
            }
            fun step(i: Int, action: String) {
                guard()
                endPhase(true, null) // pichla phase safal khatam
                lastPhase = i
                lastAction = action
                try {
                    onStep?.invoke(i, 7, action)
                } catch (_: Exception) { }
            }

            // p38: AGENT-DRIVEN join — v1 ka perceive→tap→verify robot hata diya.
            // AgentBrain v2: bounded multi-screen loop (perceive → decide → act
            // → rescan) jab tak terminal state (joined / needs_user / failed) na
            // aaye. Lock dabane ke baad naya screen aaye to agent dobara SOCHTA
            // hai — pehle jaisa "15s wait phir fail" nahi. Payment = needs_user
            // (auto-buy KABHI nahi). Koi fixed-position tap nahi.
            suspend fun runAgentPhase(
                phaseLabel: String,
                pageUrl: String,
                goal: String,
                proofName: String,
                openStep: Int,
                brainStep: Int,
                // p51: immutable campaign binding — expectedName diya to page ka
                // title/text usse match hona chahiye, warna CAMPAIGN_MISMATCH fail.
                expectedName: String? = null,
            ): AgentBrain.AgentResult {
                step(openStep, "$phaseLabel-open")
                loadUrl(pageUrl)
                waitForSettle() // p47: smart wait (fixed 2.5s hatao)
                guard()
                // p51: galat campaign pe join KABHI nahi — naam verify karo.
                if (!expectedName.isNullOrBlank()) {
                    val title = try { jsStr("document.title") } catch (_: Exception) { null }.orEmpty()
                    val bodyHead = try { jsStr("document.body.innerText.slice(0,3000)") }
                        catch (_: Exception) { null }.orEmpty()
                    val needle = expectedName.take(25).lowercase()
                    val hay = (title + "\n" + bodyHead).lowercase()
                    if (needle.isNotEmpty() && needle !in hay) {
                        throw JoinOutcome(
                            "failed",
                            "CAMPAIGN_MISMATCH: page '${title.take(60)}' me expected " +
                                "campaign '${expectedName.take(60)}' nahi mila — " +
                                "galat campaign pe join nahi karenge"
                        )
                    }
                    vars["campaign_name_verified"] = expectedName.take(60)
                }
                shots += screenshot(File(shotsDir, "proof_${proofName}_page.png"))
                vars["brain_goal"] = goal
                val res = AgentBrain.runJoinAgent(
                    ::jsStr,
                    goal,
                    maxIters = 10,
                    deadlineMs = 5 * 60_000L,
                    isDead = { com.clipflow.agent.web.LoginWebView.consumeRenderGone() },
                    onThought = { iter, thought ->
                        guard()
                        // onStep = phone heartbeat → server current_step → Live page:
                        // agent ki soch turant Live pe dikhti hai.
                        step(brainStep, "$phaseLabel-brain#$iter ${thought.take(80)}")
                        vars["brain_thought"] = thought.take(200)
                    },
                )
                // Agent ki soch Live page pe — user dekhe "dimaag" ne kya kiya
                vars["brain_trail_$proofName"] = res.trail.takeLast(6)
                    .joinToString(" | ") { "#${it.iter}[${it.pageType}] ${it.decision.take(70)}" }
                    .take(600)
                vars["brain_detail_$proofName"] = res.detail.take(300)
                shots += screenshot(File(shotsDir, "proof_${proofName}_after.png"))
                return res
            }

            // Agent fail → ek baar page text me needs_user patterns check karo
            // (Instagram connect, captcha, extra verification) — ye user ka kaam hai.
            suspend fun refineFailed(res: AgentBrain.AgentResult, label: String): Nothing {
                val txt = try {
                    JSONObject(jsStr(JS_PAGE_SNAPSHOT) ?: "{}").optString("text", "")
                } catch (_: Exception) { "" }.lowercase()
                val needUserDetail = when {
                    txt.contains("connect instagram") || txt.contains("link instagram") ->
                        "$label: campaign Instagram connect mang raha hai — Whop pe khud jaake Instagram link karo"
                    txt.contains("captcha") ->
                        "$label: page pe captcha aaya — user ko khud solve karna hoga"
                    txt.contains("verify") && txt.contains("identity") ->
                        "$label: page identity verification mang raha hai — user khud Whop pe poora kare"
                    else -> null
                }
                if (needUserDetail != null) throw JoinOutcome("needs_user", needUserDetail)
                // p39: terminal brain failure → server pe agent_issue (escalation
                // pipeline) taaki assistant root-cause dhoondh ke fix kar sake.
                // Best-effort: hook kabhi job flow nahi rokega.
                try { onBrainFailed?.invoke(label, res.detail.take(300)) } catch (_: Exception) { }
                throw JoinOutcome("failed", "$label: ${res.detail}")
            }

            suspend fun applyAgentResult(res: AgentBrain.AgentResult, label: String) {
                when (res.outcome) {
                    AgentBrain.AgentOutcome.JOINED -> { /* goal achieve — aage badho */ }
                    AgentBrain.AgentOutcome.NEEDS_USER ->
                        throw JoinOutcome("needs_user", "$label: ${res.detail}")
                    AgentBrain.AgentOutcome.FAILED ->
                        refineFailed(res, label)
                }
            }

            // Phase 1 — COMMUNITY: brand ka Whop page (locked "Content Rewards"
            // wala darwaza yahi hai — user ke screenshot wala case).
            if (whopUrl.isNotEmpty() && whopUrl.startsWith("http")) {
                applyAgentResult(
                    runAgentPhase("join-community", whopUrl, "community_join", "join_community", -1, -1),
                    "Community"
                )
            }

            // Phase 2 — CAMPAIGN: specific campaign ka member banna.
            // p39: server directive me valid goal ho to use prefer karo.
            // p51: immutable binding — payload ka campaign_name page pe verify hoga.
            val campaignName = job.optString("campaign_name", "").trim().ifEmpty { null }
            val campaignGoal =
                if (directiveGoal == "community_join" || directiveGoal == "campaign_join") directiveGoal
                else "campaign_join"
            applyAgentResult(
                runAgentPhase("join-campaign", url, campaignGoal, "join_campaign", 0, 1,
                    expectedName = campaignName),
                "Campaign"
            )

            // proof
            step(5, "join-done")
            shots += screenshot(File(shotsDir, "proof_joined.png"))
            throw JoinOutcome("joined", "Whop campaign join ho gaya (agent)")
        } catch (e: JoinOutcome) {
            val ok = e.status == "joined" || e.status == "already_joined"
            endPhase(ok, if (ok) null else "${e.status}: ${e.detail}".take(200))
            vars["join_status"] = e.status
            vars["join_detail"] = e.detail.take(300)
            previewJob.cancel() // LIVE PREVIEW: join khatam → preview band
            RunResult(ok, vars.toMap(), shots, if (ok) null else "${e.status}: ${e.detail}")
        } catch (e: Exception) {
            endPhase(false, e.message)
            vars["join_status"] = "failed"
            vars["join_detail"] = (e.message ?: "unknown error").take(300)
            previewJob.cancel() // LIVE PREVIEW: join khatam → preview band
            RunResult(false, vars.toMap(), shots, e.message)
        }
    }

    /** Join flow ka terminal outcome — exception ki tarah use hota hai (ye fail nahi). */
    private class JoinOutcome(val status: String, val detail: String) : Exception(detail)

    // ---------- join flow ke JS snippets ----------


    /** Page snapshot: login page? already joined? (JSON string deta hai). */
    private val JS_PAGE_SNAPSHOT = """
        (function(){
          var t=(document.body?document.body.innerText:'')||'';
          var url=location.href||'';
          var loginPage=/\/(login|auth|signin)/i.test(url)||/log in to whop|sign in to continue/i.test(t);
          var joined=/you're in|\byou joined\b|\bjoined\b|manage membership|my dashboard/i.test(t);
          return JSON.stringify({url:url,loginPage:loginPage,joined:joined,text:t.slice(0,3000)});
        })()
    """.trimIndent()

    /**
     * Join button dhoondho: text variants case-insensitive
     * ("Join"/"Join Campaign"/"Join now"/...), fallback: href me 'join' wala link.
     */
    private val JS_FIND_JOIN = """
        (function(){
          var els=[...document.querySelectorAll('button,a,[role=button]')];
          var norm=function(s){return (s||'').trim().replace(/\s+/g,' ').toLowerCase();};
          var pats=['join','join campaign','join now','join the campaign','join program','join this campaign'];
          for(var p of pats){
            for(var e of els){
              var l=norm(e.innerText);
              if(l===p||l.indexOf(p+' ')===0) return JSON.stringify({found:true,label:l});
            }
          }
          var link=[...document.querySelectorAll('a[href]')].find(function(a){return /join/i.test(a.getAttribute('href')||'');});
          return JSON.stringify({found:!!link,by:link?'href':null});
        })()
    """.trimIndent()

    /** Wahi find-logic + tap. jsBool ke saath use karo. */
    private val JS_CLICK_JOIN = """
        (function(){
          var els=[...document.querySelectorAll('button,a,[role=button]')];
          var norm=function(s){return (s||'').trim().replace(/\s+/g,' ').toLowerCase();};
          var pats=['join','join campaign','join now','join the campaign','join program','join this campaign'];
          for(var p of pats){
            for(var e of els){
              var l=norm(e.innerText);
              if(l===p||l.indexOf(p+' ')===0){e.scrollIntoView({block:'center'});e.click();return true;}
            }
          }
          var link=[...document.querySelectorAll('a[href]')].find(function(a){return /join/i.test(a.getAttribute('href')||'');});
          if(link){link.click();return true;}
          return false;
        })()
    """.trimIndent()

    /**
     * Content Rewards card dhoondhke TAP karo (discover page pe).
     * Card me "Content Rewards" + "Get paid to create content" text hota hai.
     * Mil gaya to click karke true, nahi to false.
     */
    private val JS_TAP_CONTENT_REWARDS = """
        (function(){
          var els=[...document.querySelectorAll('a,button,[role=button],div')];
          var norm=function(s){return (s||'').trim().replace(/\\s+/g,' ').toLowerCase();};
          // Pehle exact card dhoondho: "content rewards" text wala clickable
          for(var e of els){
            var t=norm(e.innerText);
            if(t.indexOf('content rewards')>=0 && t.indexOf('get paid to create content')>=0){
              // Sabse chhota clickable parent dhoondho
              var c=e.closest('a')||e.closest('button')||e;
              c.scrollIntoView({block:'center'});
              c.click();
              return JSON.stringify({tapped:true,by:'card'});
            }
          }
          // Fallback: koi bhi link jisme content-rewards ho
          var link=[...document.querySelectorAll('a[href]')].find(function(a){
            var h=(a.getAttribute('href')||'').toLowerCase();
            return h.indexOf('content-rewards')>=0||h.indexOf('contentrewards')>=0;
          });
          if(link){link.click();return JSON.stringify({tapped:true,by:'href'});}
          return JSON.stringify({tapped:false});
        })()
    """.trimIndent()

    /** Confirmation state: joined? ya user-action chahiye? (JSON string). */
    private val JS_JOIN_STATE = """
        (function(){
          var t=(((document.body?document.body.innerText:'')||'')).toLowerCase();
          var url=location.href||'';
          var confirmed=/you're in|\byou joined\b|\bjoined\b|welcome|membership active|success/i.test(t)||/\/(dashboard|manage|overview)/i.test(url);
          var needsUser='';
          if(/connect instagram|link instagram/i.test(t)) needsUser='campaign Instagram connect mang raha hai — Whop pe khud jaake Instagram link karo';
          else if(/captcha/i.test(t)) needsUser='page pe captcha aaya — user ko khud solve karna hoga';
          else if(/checkout|payment|complete purchase|subscribe/i.test(t)) needsUser='campaign join ke liye payment/subscription mang raha hai — user khud decide kare';
          else if(/verify your|verification required|complete your profile/i.test(t)) needsUser='page extra verification mang raha hai — user khud Whop pe jaake poora kare';
          // p35: region lock — USA proxy ke baad bhi aaye to campaign skip
          else if(/not available in your region|not eligible in your|unavailable in your (region|country)|region.{0,20}not.{0,20}supported/i.test(t)) needsUser='REGION_BLOCKED: ye campaign aapke region me available nahi hai (USA proxy ke baad bhi) — campaign skip ki gayi';
          return JSON.stringify({confirmed:confirmed,needsUser:needsUser});
        })()
    """.trimIndent()

    // ---------- verify_campaigns flow ke JS snippets ----------

    /**
     * Candidate page se nikalo: joined? pehle submit hua? requirements text?
     * official video/footage links? (JSON string deta hai.)
     * Whop ka layout badal bhi jaye to screenshot proof rehta hai.
     */
    private val JS_VERIFY_EXTRACT = """
        (function(){
          var t=(document.body?document.body.innerText:'')||'';
          var joined=/you're in|\byou joined\b|\bjoined\b|manage membership|my dashboard/i.test(t);
          var submitted=/your submission|submission pending|pending review|already submitted|submitted for review/i.test(t);
          var req='';
          var heads=[...document.querySelectorAll('h1,h2,h3,h4,strong,b')];
          for(var h of heads){
            var ht=(h.innerText||'').toLowerCase();
            if(/requirement|rules|brief|guidelines|how it works|what to do|content rules/.test(ht)){
              var sec=h.parentElement;
              var txt=sec?(sec.innerText||''):'';
              if(txt.length>req.length) req=txt;
            }
          }
          if(!req) req=t.slice(0,1500);
          var links=[...document.querySelectorAll('a[href]')].map(function(a){return a.getAttribute('href')||'';})
            .filter(function(h){return /youtube\.com|youtu\.be|drive\.google|dropbox\.com|vimeo\.com|\.mp4(\?|$)/i.test(h);});
          links=[...new Set(links)].slice(0,10).map(function(h){
            if(h.indexOf('http')!==0){ try{ h=new URL(h, location.href).href; }catch(e){} }
            return h;
          });
          return JSON.stringify({joined:joined,submitted:submitted,
            requirements:req.slice(0,2000),videoLinks:links,title:document.title||''});
        })()
    """.trimIndent()

    /**
     * verify_campaigns job ka dedicated handler (Round-7b, 2026-09-19).
     * Server ke paas Whop login NAHI hai — isliye campaign ka FINAL chunav
     * phone karta hai. Server payload: { candidates: [{campaign_id, name,
     * campaign_url, payout_per_1k_usd}] } (max 3 check hote hain).
     *
     * Har candidate: Whop page kholo (logged-in WebView) → joined?
     * requirements? video links? pehle submit? → zaroorat ho to Join dabao →
     * screenshot proof. Phir best-fit score karke CHUNO.
     *
     * Result vars: verify_status = verified | needs_user | failed,
     * chosen_campaign_id, verify_results (JSON array), verify_detail.
     * needs_user = Whop login expire / sab candidates pe extra verification.
     */
    suspend fun runVerifyCampaigns(job: JSONObject): RunResult =
        withContext(Dispatchers.Main) {
            val shots = mutableListOf<File>()
            // p35 FIX: live preview — pehle verify me preview nahi tha.
            val previewJob = startLivePreview(this)
            // p39: server brain se pull hue lessons (agar mile).
            serverLessons?.take(1500)?.let { vars["memory_lessons"] = it }
            var lastPhase = -1
            var lastAction = ""
            fun endPhase(ok: Boolean, error: String?) {
                if (lastPhase < 0) return
                try {
                    onStepEnd?.invoke(lastPhase, 99, lastAction, ok, error)
                } catch (_: Exception) { }
            }
            try {
                val cands = job.optJSONArray("candidates")
                    ?: throw VerifyOutcome("failed", "candidates missing — server ne bheje nahi")
                val n = minOf(cands.length(), 3)
                if (n == 0) throw VerifyOutcome("failed", "koi candidate nahi")
                val deadline = System.currentTimeMillis() + VERIFY_TIMEOUT_MS
                fun guard() {
                    if (rendererCrashed) throw VerifyOutcome(
                        "failed", "WebView renderer crash — job fail-mark ki gayi"
                    )
                    if (System.currentTimeMillis() > deadline) throw VerifyOutcome(
                        "failed", "verify timeout: 12 min se zyada laga"
                    )
                }
                fun step(i: Int, action: String) {
                    guard()
                    endPhase(true, null)
                    lastPhase = i
                    lastAction = action
                    try {
                        onStep?.invoke(i, 99, action)
                    } catch (_: Exception) { }
                }

                val results = mutableListOf<JSONObject>()
                var loginExpired = 0
                for (i in 0 until n) {
                    val c = cands.optJSONObject(i) ?: continue
                    val cid = c.optString("campaign_id", "")
                    val url = c.optString("campaign_url", "").trim()
                    if (cid.isEmpty() || url.isEmpty()) continue
                    step(i, "verify-open $cid")
                    loadUrl(url)
                    waitForSettle() // p47: smart wait (fixed 2.5s hatao)
                    guard()
                    shots += screenshot(File(shotsDir, "proof_verify_${i}_page.png"))

                    val snap = JSONObject(jsStr(JS_PAGE_SNAPSHOT) ?: "{}")
                    if (snap.optBoolean("loginPage", false)) {
                        loginExpired++
                        results += JSONObject()
                            .put("campaign_id", cid)
                            .put("name", c.optString("name", ""))
                            .put("joined", false)
                            .put("join_status", "needs_user")
                            .put("requirements_text", "")
                            .put("video_links", JSONArray())
                            .put("submitted", false)
                            .put("payout", c.optDouble("payout_per_1k_usd", 0.0))
                            .put("note", "whop login expire")
                        continue
                    }
                    val info = JSONObject(jsStr(JS_VERIFY_EXTRACT) ?: "{}")
                    var joined = info.optBoolean("joined", false) ||
                            snap.optBoolean("joined", false)
                    var joinStatus = if (joined) "already_joined" else ""
                    // Join nahi hai to AGENT se join kar do (p38: scripted
                    // "Join button dhoondo + tap" hata diya — agent page ko
                    // samajh ke join karta hai, lock wala Content Rewards bhi).
                    if (!joined) {
                        step(i, "verify-join $cid")
                        val ares = AgentBrain.runJoinAgent(
                            ::jsStr, "campaign_join",
                            maxIters = 8, deadlineMs = 4 * 60_000L,
                            isDead = { com.clipflow.agent.web.LoginWebView.consumeRenderGone() },
                            onThought = { iter, thought ->
                                guard()
                                vars["brain_thought"] = thought.take(200)
                                try { onStep?.invoke(i, 99, "brain#$iter ${thought.take(60)}") } catch (_: Exception) { }
                            },
                        )
                        vars["brain_trail_verify_$i"] = ares.trail.takeLast(4)
                            .joinToString(" | ") { "#${it.iter}[${it.pageType}] ${it.decision.take(60)}" }
                            .take(400)
                        when (ares.outcome) {
                            AgentBrain.AgentOutcome.JOINED -> { joined = true; joinStatus = "joined" }
                            AgentBrain.AgentOutcome.NEEDS_USER -> { joinStatus = "needs_user" }
                            // p39: verify-flow me brain terminal fail → escalation hook.
                            AgentBrain.AgentOutcome.FAILED -> {
                                joinStatus = ""
                                try { onBrainFailed?.invoke("Verify:$cid", ares.detail.take(300)) } catch (_: Exception) { }
                            }
                        }
                        shots += screenshot(File(shotsDir, "proof_verify_${i}_after.png"))
                    }
                    val vids: Any = info.optJSONArray("videoLinks") ?: JSONArray()
                    results += JSONObject()
                        .put("campaign_id", cid)
                        .put("name", c.optString("name", ""))
                        .put("joined", joined)
                        .put("join_status", joinStatus)
                        .put(
                            "requirements_text",
                            info.optString("requirements", "").take(2000)
                        )
                        .put("video_links", vids)
                        .put("submitted", info.optBoolean("submitted", false))
                        .put("payout", c.optDouble("payout_per_1k_usd", 0.0))
                }
                if (results.isEmpty()) throw VerifyOutcome(
                    "failed", "koi candidate check nahi ho paya"
                )
                if (loginExpired == n) throw VerifyOutcome(
                    "needs_user",
                    "Whop login expire ho gaya — app me Whop dobara login karo"
                )

                // Best-fit scoring: joined +2, not-submitted +2 (submitted −5),
                // video links +1, requirements +1, payout tiebreak.
                fun score(r: JSONObject): Double {
                    var s = 0.0
                    if (r.optBoolean("joined", false)) s += 2
                    if (r.optBoolean("submitted", false)) s -= 5 else s += 2
                    if ((r.optJSONArray("video_links")?.length() ?: 0) > 0) s += 1
                    if (r.optString("requirements_text", "").length > 100) s += 1
                    s += minOf(r.optDouble("payout", 0.0) / 10.0, 1.0)
                    return s
                }
                val eligible = results.filter {
                    it.optString("join_status", "") != "needs_user"
                }
                val pool = if (eligible.isNotEmpty()) eligible else results
                val best = pool.maxByOrNull { score(it) }!!
                val chosenId = best.optString("campaign_id", "")
                val detail = "best-fit: $chosenId (score ${"%.1f".format(score(best))}, " +
                        "joined=${best.optBoolean("joined")}, " +
                        "videos=${best.optJSONArray("video_links")?.length() ?: 0})"

                step(n, "verify-done")
                shots += screenshot(File(shotsDir, "proof_verify_chosen.png"))
                endPhase(true, null)
                vars["verify_status"] = "verified"
                vars["chosen_campaign_id"] = chosenId
                vars["verify_results"] = JSONArray(results).toString()
                vars["verify_detail"] = detail.take(300)
                RunResult(true, vars.toMap(), shots, null)
            } catch (e: VerifyOutcome) {
                val ok = e.status == "verified"
                endPhase(ok, if (ok) null else "${e.status}: ${e.detail}".take(200))
                vars["verify_status"] = e.status
                vars["verify_detail"] = e.detail.take(300)
                previewJob.cancel() // LIVE PREVIEW: verify khatam → preview band
                RunResult(ok, vars.toMap(), shots, if (ok) null else "${e.status}: ${e.detail}")
            } catch (e: Exception) {
                endPhase(false, e.message)
                vars["verify_status"] = "failed"
                vars["verify_detail"] = (e.message ?: "unknown error").take(300)
                previewJob.cancel() // LIVE PREVIEW: verify khatam → preview band
                RunResult(false, vars.toMap(), shots, e.message)
            }
        }

    /** Discover flow ka terminal outcome — exception ki tarah use hota hai. */
    private class DiscoverOutcome(val status: String, val detail: String) : Exception(detail)

    /**
     * discover_campaigns job ka dedicated handler (Round-7b, 2026-09-19).
     * Server ke paas Whop login NAHI hai — naye Content Rewards campaigns bhi
     * phone dhoondta hai. Server payload: { discover_url } (default
     * https://whop.com/hub/).
     *
     * Flow: logged-in Whop me discover_url kholo → login check → 3x scroll
     * (cards load hon) → campaign links + payout text nikalo → screenshot
     * proof. Server result se campaigns table me upsert karta hai.
     *
     * Result vars: discover_status = discovered | needs_user | failed,
     * discover_results (JSON array), discover_detail.
     * needs_user = Whop login expire.
     */
    suspend fun runDiscoverCampaigns(job: JSONObject): RunResult =
        withContext(Dispatchers.Main) {
            val shots = mutableListOf<File>()
            // p35 FIX: live preview — pehle discover me preview nahi tha.
            val previewJob = startLivePreview(this)
            // p39: server brain se pull hue lessons (agar mile).
            serverLessons?.take(1500)?.let { vars["memory_lessons"] = it }
            var lastPhase = -1
            var lastAction = ""
            fun endPhase(ok: Boolean, error: String?) {
                if (lastPhase < 0) return
                try {
                    onStepEnd?.invoke(lastPhase, 99, lastAction, ok, error)
                } catch (_: Exception) { }
            }
            try {
                val url = job.optString("discover_url", "").trim()
                    .ifEmpty { "https://whop.com/hub/" }
                val deadline = System.currentTimeMillis() + DISCOVER_TIMEOUT_MS
                fun guard() {
                    if (rendererCrashed) throw DiscoverOutcome(
                        "failed", "WebView renderer crash — job fail-mark ki gayi"
                    )
                    if (System.currentTimeMillis() > deadline) throw DiscoverOutcome(
                        "failed", "discover timeout: 8 min se zyada laga"
                    )
                }
                fun step(i: Int, action: String) {
                    guard()
                    endPhase(true, null)
                    lastPhase = i
                    lastAction = action
                    try {
                        onStep?.invoke(i, 99, action)
                    } catch (_: Exception) { }
                }

                // 0) whop.com/discover/ kholo (logged-in Whop session)
                // Phir "Content Rewards" card TAP karo → asli campaigns page khulta hai
                step(0, "discover-open")
                loadUrl("https://whop.com/discover/")
                waitForSettle() // p47: smart wait (fixed 3s hatao)
                guard()
                val snap = JSONObject(jsStr(JS_PAGE_SNAPSHOT) ?: "{}")
                if (snap.optBoolean("loginPage", false)) {
                    throw DiscoverOutcome(
                        "needs_user",
                        "Whop login expire ho gaya — app me Whop dobara login karo"
                    )
                }

                // 0a) Content Rewards card TAP karo (screenshot jaisa card)
                step(0, "discover-tap-rewards")
                var tapped = false
                try {
                    val tapRes = JSONObject(jsStr(JS_TAP_CONTENT_REWARDS) ?: "{}")
                    tapped = tapRes.optBoolean("tapped", false)
                    if (tapped) {
                        // Navigation ka wait karo (URL badalna chahiye)
                        val beforeUrl = snap.optString("url", "")
                        for (waitIter in 1..10) {
                            delay(2000)
                            guard()
                            val now = JSONObject(jsStr(JS_PAGE_SNAPSHOT) ?: "{}")
                            val nowUrl = now.optString("url", "")
                            if (nowUrl != beforeUrl && nowUrl.contains("content-rewards")) break
                        }
                    }
                } catch (_: Exception) { }
                if (!tapped) {
                    // Fallback: direct URL try karo
                    loadUrl(url)
                    delay(4000)
                    guard()
                }
                shots += screenshot(File(shotsDir, "proof_discover_rewards.png"))

                // 0b) Content Rewards iframe dhoondo — campaign cards iframe
                // (apps.whop.com) ke andar render hote hain, top document me
                // sirf nav items milte hain. Mil gaya to uske src pe navigate
                // karo taaki cards same-origin scrape ho saken.
                var iframeDbg = "iframe: not checked"
                try {
                    val frameInfo = JSONObject(jsStr(JS_FIND_REWARDS_FRAME) ?: "{}")
                    if (frameInfo.optBoolean("found", false)) {
                        val frameSrc = frameInfo.optString("src", "").trim()
                        iframeDbg = "iframe: found src=" + frameSrc.take(80)
                        if (frameSrc.isNotEmpty()) {
                            loadUrl(frameSrc)
                            delay(4000)
                            guard()
                            iframeDbg += " navigated"
                        }
                    } else {
                        iframeDbg = "iframe: NOT found (" + frameInfo.optInt("iframeCount", -1) + " iframes)"
                        // Debug: saare iframe srcs dikhao taaki pata chale kya hai
                        val srcs = frameInfo.optJSONArray("allSrcs")
                        if (srcs != null && srcs.length() > 0) {
                            iframeDbg += " srcs=[" + (0 until minOf(srcs.length(), 3)).joinToString(",") { srcs.optString(it).take(60) } + "]"
                        }
                    }
                } catch (_: Exception) { iframeDbg = "iframe: check error" }
                shots += screenshot(File(shotsDir, "proof_discover_hub.png"))

                // 1) scroll karke cards load karao
                step(1, "discover-scroll")
                repeat(3) {
                    jsStr("(function(){window.scrollBy(0,document.body.scrollHeight);return 'ok';})()")
                    delay(2000)
                    guard()
                }
                jsStr("(function(){window.scrollTo(0,0);return 'ok';})()")
                shots += screenshot(File(shotsDir, "proof_discover_cards.png"))

                // 2) campaign links + payout nikalo
                step(2, "discover-extract")
                val info = JSONObject(jsStr(JS_DISCOVER_EXTRACT) ?: "{}")
                val arr = info.optJSONArray("results") ?: JSONArray()
                val results = mutableListOf<JSONObject>()
                for (i in 0 until arr.length()) {
                    results += arr.optJSONObject(i) ?: continue
                }
                step(3, "discover-done")
                endPhase(true, null)
                vars["discover_status"] = "discovered"
                vars["discover_results"] = JSONArray(results).toString()
                val dbgInfo = info.optJSONObject("debug")
                val dbgStr = if (dbgInfo != null) " links=" + dbgInfo.optInt("totalLinks", 0) + " whop=" + dbgInfo.optInt("whopLinks", 0) else ""
                val skippedArr = info.optJSONArray("skipped")
                val skippedStr = if (skippedArr != null) " skipped=[" + (0 until minOf(skippedArr.length(), 3)).joinToString(",") { skippedArr.optString(it).take(50) } + "]" else ""
                vars["discover_detail"] =
                    "${results.size} campaigns mile (${info.optString("title", "").take(40)}) | " + iframeDbg + dbgStr + skippedStr
                        .take(300)
                RunResult(true, vars.toMap(), shots, null)
            } catch (e: DiscoverOutcome) {
                val ok = e.status == "discovered"
                endPhase(ok, if (ok) null else "${e.status}: ${e.detail}".take(200))
                vars["discover_status"] = e.status
                vars["discover_detail"] = e.detail.take(300)
                previewJob.cancel() // LIVE PREVIEW: discover khatam → preview band
                RunResult(ok, vars.toMap(), shots, if (ok) null else "${e.status}: ${e.detail}")
            } catch (e: Exception) {
                endPhase(false, e.message)
                vars["discover_status"] = "failed"
                vars["discover_detail"] = (e.message ?: "unknown error").take(300)
                previewJob.cancel() // LIVE PREVIEW: discover khatam → preview band
                RunResult(false, vars.toMap(), shots, e.message)
            }
        }

    /** Content Rewards iframe dhoondo (campaign cards isi me render hote hain). */
    private val JS_FIND_REWARDS_FRAME = """
        (function(){
          var frames=[...document.querySelectorAll('iframe')];
          var allSrcs=[];
          for(var f of frames){
            var t=(f.getAttribute('title')||'').toLowerCase();
            var s=f.getAttribute('src')||f.getAttribute('data-src')||'';
            allSrcs.push((t||'?').slice(0,30)+'|'+s.slice(0,60));
            // STRICT: sirf Content Rewards ka iframe — 'rewards' akela kaafi nahi
            // (Pandax jaisi galat iframe pakad leta tha). URL me content-rewards
            // ya contentrewards.com hona chahiye.
            if((t.indexOf('content rewards')>=0 && s.indexOf('content-rewards')>=0) ||
               s.indexOf('contentrewards.com')>=0 ||
               s.indexOf('/content-rewards')>=0){
              var abs=s;
              if(abs && abs.indexOf('http')!==0){
                try{ abs=new URL(abs, location.href).href; }catch(e){}
              }
              return JSON.stringify({found:true, src:abs, title:f.getAttribute('title')||''});
            }
          }
          return JSON.stringify({found:false, iframeCount:frames.length, allSrcs:allSrcs.slice(0,5)});
        })()
    """.trimIndent()

    /** Discover page se campaign cards: whop.com links + payout text. */
    private val JS_DISCOVER_EXTRACT = """
        (function(){
          var seen={};
          var out=[];
          var dbg={totalLinks:0, whopLinks:0, skippedNav:0, skippedPath:0, skippedCtx:0, samples:[]};
          // Nav/header/footer ke generic naam — ye campaigns nahi hain.
          var NAV_NAME=/^(content rewards|bounties|joined|discover|home|dashboard|wallet|payouts?|settings|profile|notifications?|messages?|search|explore|earn|rewards)$/i;
          var links=[...document.querySelectorAll('a[href]')];
          dbg.totalLinks=links.length;
          for(var a of links){
            var h=a.getAttribute('href')||'';
            if(h.indexOf('http')!==0){ try{ h=new URL(h, location.href).href; }catch(e){ continue; } }
            // whop.com, apps.whop.com, contentrewards.com — sab allowed
            if(!/^https:\/\/(www\.)?(whop\.com|apps\.whop\.com|contentrewards\.com)\//i.test(h)) continue;
            dbg.whopLinks++;
            var path='/';
            try{ path=new URL(h).pathname; }catch(e){}
            if(/^\/(hub|discover|login|signup|auth|settings|billing|apps?|wallet|payouts?|notifications?|messages?)(\/?$|\?)/i.test(path)) continue;
            if(seen[h]) continue;
            seen[h]=1;
            var name=((a.innerText||a.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ')).slice(0,120);
            if(!name || NAV_NAME.test(name)) { if(dbg.samples.length<10) dbg.samples.push({h:h,name:name||'(empty)'}); continue; }
            // Campaign URL me kam se kam 2 path segments hone chahiye
            // (e.g. /company/campaign ya /discover/uuid)
            var segs=path.split('/').filter(function(s){return s.length>0;});
            if(segs.length<1) { dbg.samples.push({h:h,name:name}); continue; } // 1+ segments
            var card=a.closest('div');
            var ctx=((a.innerText||'')+' '+(card?(card.innerText||''):'')).slice(0,800);
            var pm=ctx.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:\/|per)\s*1,?000/i);
            // Budget: "$52K remaining" ya "$1,000 budget" jaisa text
            var bm=ctx.match(/\$\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(K|M)?\s*(remaining|left|budget)/i);
            var budgetTxt=bm?bm[0]:'';
            // Duration: "15-30 seconds" ya "min 15s" jaisa text
            var dm=ctx.match(/(\d+)\s*-\s*(\d+)\s*(sec|seconds)/i);
            var durTxt=dm?dm[0]:'';
            if(pm || /reward|clip|earn|bounty|campaign/i.test(ctx)){
              out.push({name:name, campaign_url:h, payout_text: pm?pm[0]:'',
                budget_text: budgetTxt, duration_text: durTxt,
                requirements_text: ctx.slice(0,500)});
            } else {
              if(dbg.samples.length<10) dbg.samples.push({h:h,name:name+' [no-kw]'});
            }
          }
          // Debug: pehle 5 skipped links ke samples rakho
          var skippedSamples=dbg.samples.slice(0,5).map(function(s){return s.h.slice(0,60)+'|'+s.name.slice(0,30);});
          return JSON.stringify({count:out.length, results:out.slice(0,15), title:document.title||'', debug:dbg, skipped:skippedSamples});
        })()
    """.trimIndent()

    /** Verify flow ka terminal outcome — exception ki tarah use hota hai. */
    private class VerifyOutcome(val status: String, val detail: String) : Exception(detail)

    /**
     * LIVE PREVIEW (p35 fix, 2026-09-20): preview loop ab reusable function.
     * PEHLE BUG: ye sirf run() me tha — runJoinCampaign/runVerifyCampaigns/
     * runDiscoverCampaigns me nahi tha, isliye join ke time Live page pe
     * PURANA stale screenshot dikhta tha (Instagram home). Ab chaaro handlers
     * ise start karte hain.
     * Returns: Job (caller cancel kare jab kaam khatam).
     */
    private suspend fun startLivePreview(scope: CoroutineScope): Job {
        return scope.launch(Dispatchers.IO) {
            val previewDir = File(context.cacheDir, "live_preview").apply { mkdirs() }
            val inAppFile = File(context.filesDir, "live_inapp.png")
            var lastServerUpload = 0L
            while (isActive) {
                // p52: har Throwable pakdo (Exception NAHI — Error bhi).
                // Bitmap.createBitmap OOM (Error) pehle yahan se nikal ke
                // structured concurrency se POORA engine scope cancel kar
                // deta tha: worker silent-dead, heartbeat band, koi terminal
                // report nahi (2026-09-21 JOIN_BUTTON incident). Ab preview
                // kabhi engine ko nahi marega — worst case ye tick skip.
                try {
                    delay(3000) // har 3 sec me in-app preview
                    val f = File(previewDir, "live.png")
                    // p52: seedha 480px pe draw — pehle 1920x1080 (~8.3MB)
                    // bitmap banta tha har 3 sec me, jo memory pressure pe
                    // OOM ka sabse bada candidate tha. Preview ke liye 480px
                    // hi upload hota tha, isliye quality loss nahi.
                    val bmp = withContext(Dispatchers.Main) {
                        val w = if (webView.width > 0) webView.width else 1080
                        val h = if (webView.height > 0) webView.height else 1920
                        val sw = 480
                        val sh = (h * sw / w)
                        val small = Bitmap.createBitmap(sw, sh, Bitmap.Config.ARGB_8888)
                        val c = Canvas(small)
                        c.scale(sw.toFloat() / w, sh.toFloat() / h)
                        webView.draw(c)
                        small
                    }
                    withContext(Dispatchers.IO) {
                        FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 80, it) }
                        // In-app preview: har 3 sec me overwrite (Profile tab padhta hai)
                        FileOutputStream(inAppFile).use { bmp.compress(Bitmap.CompressFormat.PNG, 80, it) }
                        bmp.recycle()
                    }
                    // Server ko har 15 sec me bhejo (3 sec * 5 = 15 sec)
                    val now = System.currentTimeMillis()
                    if (now - lastServerUpload >= 15000) {
                        lastServerUpload = now
                        reporter?.uploadLivePreview(f)
                    }
                } catch (_: Throwable) { /* preview fail = silent, engine kabhi nahi marega */ }
            }
        }
    }

    suspend fun run(job: JSONObject): RunResult = withContext(Dispatchers.Main) {
        val shots = mutableListOf<File>()
        val warnings = mutableListOf<String>()
        // LIVE PREVIEW: job chalte hue har 15 sec me screenshot server ko
        val previewJob = startLivePreview(this)
        // p39: server brain se pull hue lessons (agar mile).
        serverLessons?.take(1500)?.let { vars["memory_lessons"] = it }
        try {
            val steps = job.getJSONArray("steps")
            val total = steps.length()
            val deadline = System.currentTimeMillis() + JOB_TIMEOUT_MS
            var lastStepDoneAt = System.currentTimeMillis()
            for (i in 0 until total) {
                if (rendererCrashed) {
                    throw Exception("WebView renderer crash ho gaya (tab crash) — job fail-mark ki gayi")
                }
                if (System.currentTimeMillis() > deadline) {
                    throw Exception("job timeout: 20 min se zyada atak gaya tha — fail-mark kiya gaya")
                }
                // Round-7 WATCHDOG: pichla step complete hue 10 min se zyada
                // ho gaye = ye step kahin atak gaya → fail-mark, silent dead nahi.
                val stallMs = System.currentTimeMillis() - lastStepDoneAt
                if (stallMs > STEP_TIMEOUT_MS) {
                    throw Exception(
                        "step stall: step ${i + 1}/$total (${steps.getJSONObject(i).optString("action", "?")}) " +
                            "${stallMs / 60000} min se complete nahi hua — fail-mark kiya gaya"
                    )
                }
                val s = steps.getJSONObject(i)
                val action = s.optString("action", "?")
                try {
                    onStep?.invoke(i, total, action)
                } catch (_: Exception) { }
                try {
                    // optional step: fail ho to warning note karke aage badho
                    if (s.optBoolean("optional", false)) {
                        try {
                            execStep(s, shots)
                        } catch (e: Exception) {
                            val w = "step ${i} (${s.optString("phase", action)}): ${e.message}"
                            warnings += w.take(200)
                            try {
                                onStepEnd?.invoke(i, total, action, true, "optional-fail: ${e.message}".take(200))
                            } catch (_: Exception) { }
                        }
                    } else {
                        execStep(s, shots)
                        try {
                            onStepEnd?.invoke(i, total, action, true, null)
                        } catch (_: Exception) { }
                    }
                } catch (e: Exception) {
                    // Round-7: step fail TURANT caller ko (heartbeat pe jayega) —
                    // phir bhi throw taaki job fail-mark ho aur server ko report jaye.
                    try {
                        onStepEnd?.invoke(i, total, action, false, e.message)
                    } catch (_: Exception) { }
                    throw e
                }
                lastStepDoneAt = System.currentTimeMillis()
            }
            if (warnings.isNotEmpty()) vars["warnings"] = warnings.joinToString(" | ")
            RunResult(true, vars.toMap(), shots)
        } catch (e: Exception) {
            if (warnings.isNotEmpty()) vars["warnings"] = warnings.joinToString(" | ")
            // FAILURE DIAGNOSTICS (Round-7): fail hone par bhi screenshot proof +
            // URL/title/body-excerpt vars me bhejo — pehle failed runs me
            // screenshots[] khaali rehta tha, job list me koi proof nahi milta tha.
            try { vars["fail_url"] = webView.url ?: "" } catch (_: Exception) { }
            try { vars["fail_title"] = webView.title ?: "" } catch (_: Exception) { }
            try {
                val body = withTimeout(10_000) {
                    jsStr("(document.body ? document.body.innerText : '')")
                } ?: ""
                vars["fail_body"] = body.take(800)
            } catch (_: Exception) { }
            try {
                shots += screenshot(File(shotsDir, "fail_proof.png"))
            } catch (_: Exception) { }
            RunResult(false, vars.toMap(), shots, e.message)
        } finally {
            previewJob.cancel() // LIVE PREVIEW: job khatam → preview band
        }
    }

    // ---------- steps ----------

    private suspend fun execStep(s: JSONObject, shots: MutableList<File>) {
        when (s.getString("action")) {
            "download" -> {
                val url = fill(s.getString("url"))
                val name = s.getString("as")
                download(url, File(filesDir, name))
            }
            "navigate" -> {
                loadUrl(fill(s.getString("url")))
                waitForSettle() // p47: smart wait (fixed 2.5s hatao)
            }
            "click" -> {
                val ok = jsBool(clickJs(s))
                if (!ok) throw Exception("click fail: ${s.optString("value")}")
                delay(1200)
            }
            "type" -> {
                val ok = jsBool(typeJs(s, fill(s.getString("text"))))
                if (!ok) throw Exception("type fail: ${s.optString("value")}")
                delay(800)
            }
            "upload" -> {
                val file = File(filesDir, s.getString("file"))
                if (!file.exists()) throw Exception("upload file missing: ${file.name}")
                // Round-7 (Worker A) fix: served reset karo — warna doosre
                // upload step pe purana 'true' dekhke chooser ka wait skip ho
                // jata tha (file attach hue bina aage badh jata tha).
                chrome.served = false
                chrome.pendingFile = file
                val ok = jsBool(clickJs(s))
                if (!ok) throw Exception("upload click fail")
                // onShowFileChooser callback ka wait
                val got = withContext(Dispatchers.IO) {
                    var n = 0
                    while (!chrome.served && n < 100) { Thread.sleep(200); n++ }
                    chrome.served
                }
                if (!got) throw Exception("file chooser timeout")
                delay(1500)
            }
            "wait_url" -> {
                val contains = s.getString("contains")
                val timeout = s.optLong("timeout", 60000)
                val t0 = System.currentTimeMillis()
                while (System.currentTimeMillis() - t0 < timeout) {
                    val url = jsStr("location.href") ?: ""
                    if (url.contains(contains)) return
                    delay(700)
                }
                throw Exception("wait_url timeout: $contains")
            }
            "wait_text" -> {
                val text = s.getString("text")
                val timeout = s.optLong("timeout", 30000)
                val t0 = System.currentTimeMillis()
                while (System.currentTimeMillis() - t0 < timeout) {
                    val found = jsBool(
                        "(document.body && document.body.innerText || '').includes(${q(text)})"
                    )
                    if (found) return
                    delay(700)
                }
                throw Exception("wait_text timeout: $text")
            }
            // wait_js: JS condition truthy hone ka wait (icon-only buttons jaise
            // Instagram ka "+" Create button jisme text nahi hota). 2026-09-20 fix:
            // wait_text "Create" kabhi match nahi hota tha kyunki mobile web me
            // wo ek icon hai — isliye ye action add kiya.
            "wait_js" -> {
                val cond = fill(s.getString("js"))
                val timeout = s.optLong("timeout", 30000)
                val t0 = System.currentTimeMillis()
                while (System.currentTimeMillis() - t0 < timeout) {
                    try {
                        if (jsBool("(function(){try{return ($cond)}catch(e){return false}})()")) return
                    } catch (_: Exception) { /* eval fail = not ready yet */ }
                    delay(700)
                }
                throw Exception("wait_js timeout: ${cond.take(80)}")
            }
            "eval" -> { jsStr(fill(s.getString("js"))) }
            "assert" -> {
                val ok = jsBool(fill(s.getString("js")))
                if (!ok) throw Exception(s.optString("message", "assert failed"))
            }
            "extract" -> {
                val v = jsStr(fill(s.getString("js"))) ?: ""
                vars[s.getString("as")] = v
            }
            "screenshot" -> {
                shots += screenshot(File(shotsDir, s.getString("as")))
            }
            // ---------- Browser Agent v1 (2026-09-21) ----------
            // extract_structured { url, script, timeout_ms }:
            //   URL load → evaluateJavascript(script) → result JSON string →
            //   vars["extract_structured_result"] (+ reporter/job result me
            //   structured payload server ko). script me JSON.stringify(...)
            //   use karo taaki result ek JSON string ho.
            "extract_structured" -> execExtractStructured(s, shots)
            // social_reply { post_url, text, selectors[] } /
            // social_message { profile_url, text, selectors[] }:
            //   page kholo → selectors fallback order me reply/DM box
            //   dhoondo → text type karo → dry_run ho to SEND MAT KARO
            //   (sirf navigate+verify, result me "dry_run_ok").
            "social_reply" -> execSocialAction(s, shots, kind = "reply")
            "social_message" -> execSocialAction(s, shots, kind = "message")
            else -> throw Exception("unknown action: ${s.getString("action")}")
        }
    }

    // ---------- Browser Agent v1 actions (2026-09-21) ----------

    /**
     * IG action-block guard (standing rule — naye actions me bhi).
     * Page pe restriction text mile to "action blocked: ..." throw karo —
     * AutomationWorker.isBlocked() ise "blocked" status dega aur server
     * 24h auto-pause lagayega (existing guard, wahi behavior).
     */
    private suspend fun checkActionBlock() {
        val body = try {
            jsStr("(document.body ? document.body.innerText : '')")
        } catch (_: Exception) { null } ?: return
        val t = body.lowercase()
        val hit = t.contains("action blocked") ||
            t.contains("try again later") ||
            (t.contains("temporarily") && t.contains("restricted")) ||
            t.contains("we suspect automated behavior")
        if (hit) {
            throw Exception(
                "action blocked: page pe restriction text mila — " +
                    "ye job 'blocked' report hoga (24h auto-pause)"
            )
        }
    }

    /**
     * extract_structured: URL load → script eval → JSON result.
     * eval pe existing 30s hard cap (JS_EVAL_TIMEOUT_MS) lagu hota hai —
     * timeout_ms usse zyada ho to bhi 30s hi milega.
     */
    private suspend fun execExtractStructured(s: JSONObject, shots: MutableList<File>) {
        val url = fill(s.optString("url", ""))
        if (url.isEmpty()) throw Exception("extract_structured: url missing")
        val script = fill(s.optString("script", ""))
        if (script.isEmpty()) throw Exception("extract_structured: script missing")
        loadUrl(url)
        waitForSettle() // p47: smart wait (fixed 2.5s hatao)
        checkActionBlock()
        val raw = try {
            jsStr(script)
        } catch (e: Exception) {
            throw Exception("extract_structured: js eval fail — ${e.message}")
        } ?: throw Exception("extract_structured: script ne null diya")
        // Result ek valid JSON string hona chahiye (script me JSON.stringify).
        val trimmed = raw.trim()
        val okJson = (trimmed.startsWith("{") || trimmed.startsWith("[")) && try {
            if (trimmed.startsWith("{")) JSONObject(trimmed) else JSONArray(trimmed)
            true
        } catch (_: Exception) { false }
        if (!okJson) {
            throw Exception(
                "extract_structured: result JSON nahi hai (script me JSON.stringify use karo)"
            )
        }
        vars["extract_structured_result"] = raw.take(20000)
        shots += screenshot(File(shotsDir, "proof_extract.png"))
    }

    /**
     * social_reply / social_message: open → box dhoondo (selectors fallback,
     * phir heuristic) → type → dry_run me SEND NAHI.
     * Non-dry-run me send button click karne ki koshish; na mile to fail
     * (typed text chhoda, bina bheje — send fail-safe).
     */
    private suspend fun execSocialAction(s: JSONObject, shots: MutableList<File>, kind: String) {
        val urlKey = if (kind == "reply") "post_url" else "profile_url"
        val url = fill(s.optString(urlKey, ""))
        if (url.isEmpty()) throw Exception("social_$kind: $urlKey missing")
        val text = fill(s.optString("text", ""))
        if (text.isEmpty()) throw Exception("social_$kind: text missing")
        val dryRun = s.optBoolean("dry_run", false)

        loadUrl(url)
        waitForSettle() // p47: smart wait (fixed 2.5s hatao)
        checkActionBlock()
        shots += screenshot(File(shotsDir, "proof_social_${kind}_page.png"))

        // 1) selectors fallback order me try karo
        var typed = false
        var usedSel = ""
        val sels = s.optJSONArray("selectors")
        if (sels != null) {
            for (i in 0 until sels.length()) {
                val sel = sels.optJSONObject(i) ?: continue
                val pseudo = JSONObject()
                    .put("by", sel.optString("by", "css"))
                    .put("value", sel.optString("value", ""))
                if (pseudo.optString("value").isEmpty()) continue
                try {
                    if (jsBool(typeJs(pseudo, text))) {
                        typed = true
                        usedSel = "selector[$i]"
                        break
                    }
                } catch (_: Exception) { /* agla selector */ }
            }
        }
        // 2) heuristic fallback: visible contenteditable / textbox
        if (!typed) {
            typed = try { jsBool(jsWith(JS_TYPE_FALLBACK, text)) } catch (_: Exception) { false }
            if (typed) usedSel = "heuristic"
        }
        if (!typed) {
            throw Exception(
                "social_$kind: reply/message box nahi mila (selectors + fallback dono fail)"
            )
        }
        delay(800)
        shots += screenshot(File(shotsDir, "proof_social_${kind}_typed.png"))

        // DRY-RUN: navigate + type verify ho gaya — SEND MAT KARO.
        if (dryRun) {
            vars["social_${kind}_status"] = "dry_run_ok"
            vars["social_${kind}_detail"] =
                "navigate + type verify ho gaya; send NAHI kiya (dry_run=true)"
            return
        }
        checkActionBlock()
        // 3) send button dhoondho (Send/Reply/Post/Submit)
        val sent = try { jsBool(JS_CLICK_SEND) } catch (_: Exception) { false }
        if (!sent) {
            throw Exception(
                "social_$kind: text type ho gaya lekin send button nahi mila — " +
                    "typed text chhoda, bina bheje (fail-safe)"
            )
        }
        delay(2500)
        checkActionBlock()
        shots += screenshot(File(shotsDir, "proof_social_${kind}_sent.png"))
        vars["social_${kind}_status"] = "sent"
        vars["social_${kind}_detail"] = "text bheja gaya ($usedSel)".take(200)
    }

    /** text ko q(text) ke saath JS snippet me inject karne ka helper. */
    private fun jsWith(snippet: String, text: String): String =
        snippet.replace("%%TEXT%%", JSONObject.quote(text))

    /**
     * typeJs ke liye heuristic: pehla visible contenteditable / textarea /
     * text-input dhoondho, focus + insertText. React-controlled inputs pe
     * native setter + input event bhi dispatch karo.
     */
    private val JS_TYPE_FALLBACK = """
        (function(T){
          function visible(el){
            var r=el.getBoundingClientRect();
            return r.width>10&&r.height>10&&r.bottom>0&&r.right>0;
          }
          var cands=[...document.querySelectorAll(
            '[contenteditable="true"],textarea,input[type="text"],input:not([type])')];
          var el=cands.find(visible);
          if(!el) return false;
          el.scrollIntoView({block:'center'});
          el.focus();
          try{document.execCommand('selectAll',false,null);}catch(e){}
          var ok=false;
          try{ok=document.execCommand('insertText',false,T);}catch(e){}
          if(!ok){
            try{
              var proto=el.isContentEditable?HTMLElement.prototype:
                (el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype);
              var d=Object.getOwnPropertyDescriptor(proto,'value')||
                    Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');
              if(el.isContentEditable){el.innerText=T;}
              else if(d&&d.set){d.set.call(el,T);}
              else{el.value=T;}
              el.dispatchEvent(new Event('input',{bubbles:true}));
              el.dispatchEvent(new Event('change',{bubbles:true}));
            }catch(e){return false;}
          }
          return true;
        })(%%TEXT%%)
    """.trimIndent()

    /** Send/Reply/Post/Submit button: text ya aria-label match + click. */
    private val JS_CLICK_SEND = """
        (function(){
          var els=[...document.querySelectorAll('button,a,[role=button],input[type=submit]')];
          var norm=function(s){return (s||'').trim().replace(/\s+/g,' ').toLowerCase();};
          var pats=['send','reply','post','submit','message'];
          for(var p of pats){
            for(var e of els){
              var l=norm(e.innerText)||norm(e.getAttribute('aria-label'))||norm(e.value);
              if(!l) continue;
              if(l===p||l.indexOf(p)===0){
                var r=e.getBoundingClientRect();
                if(r.width<4||r.height<4) continue;
                e.scrollIntoView({block:'center'});
                e.click();
                return true;
              }
            }
          }
          return false;
        })()
    """.trimIndent()

    /**
     * live_session job ka dedicated handler (Browser Agent v1, 2026-09-21).
     * Server payload: { job_id }.
     *
     * Loop (~10s cadence):
     *   1. screenshot → JPEG q60, 540px wide, ≤200KB → base64 →
     *      POST /api/devices/:id/live/frame { job_id, frame }
     *   2. GET /api/devices/:id/live/step?job_id= → { step } ho to ek step
     *      execStep se execute karo (try/catch + vars me error).
     *   3. { stop:true } → loop exit, job complete report.
     *   4. frame POST 404 (ya step GET 404 lagataar 6 baar) = job server pe
     *      nahi raha → exit (cancelled/deleted treat).
     *
     * Stall safety: 30-min cap, renderer-crash flag, har iteration me
     * checkActionBlock (IG block → 24h auto-pause wahi guard).
     */
    suspend fun runLiveSession(job: JSONObject): RunResult =
        withContext(Dispatchers.Main) {
            val shots = mutableListOf<File>()
            serverLessons?.take(1500)?.let { vars["memory_lessons"] = it }
            try {
                val jobId = job.optString("job_id", "")
                    .ifEmpty { job.optString("id", "") }
                    .trim()
                if (jobId.isEmpty()) throw Exception("live_session: job_id missing")
                val deadline = System.currentTimeMillis() + LIVE_SESSION_TIMEOUT_MS
                var frames = 0
                var step404s = 0
                fun step(i: Int, action: String) {
                    try { onStep?.invoke(i, 0, action) } catch (_: Exception) { }
                }
                while (System.currentTimeMillis() < deadline) {
                    if (rendererCrashed) throw Exception(
                        "WebView renderer crash ho gaya (live session) — job fail-mark ki gayi"
                    )
                    frames++
                    step(frames, "live-frame#$frames")

                    // 1) frame post (JPEG q60 540w, ≤200KB, base64)
                    val frameB64 = try {
                        captureLiveFrame()
                    } catch (e: Exception) {
                        vars["live_warn"] = "frame capture fail: ${e.message}".take(200)
                        null
                    }
                    if (frameB64 != null) {
                        try {
                            withContext(Dispatchers.IO) {
                                com.clipflow.agent.net.ApiClient.postLiveFrame(store, jobId, frameB64)
                            }
                        } catch (e: com.clipflow.agent.net.ApiException) {
                            if (e.code == 404) {
                                // server job ko nahi janta (endpoint purana ya
                                // job cancelled) → loop exit, dobara post nahi.
                                vars["live_status"] = "ended_server_gone"
                                vars["live_frames"] = "$frames"
                                return@withContext RunResult(true, vars.toMap(), shots, null)
                            }
                            vars["live_warn"] = "frame post fail: ${e.message}".take(200)
                        } catch (e: Exception) {
                            vars["live_warn"] = "frame post fail: ${e.message}".take(200)
                        }
                    }

                    // 2) pending step poll
                    val cmd = try {
                        withContext(Dispatchers.IO) {
                            com.clipflow.agent.net.ApiClient.getLiveStep(store, jobId)
                        }
                    } catch (_: Exception) {
                        null // transient net blip — loop jari rakho
                    }
                    if (cmd == null) {
                        // 404: server pe job khatam/cancelled — lagataar 6 baar
                        // = pakka gaya, exit. (Server zinda ho to {ok:true} deta
                        // hai, 404 nahi.)
                        step404s++
                        if (step404s >= 6) {
                            vars["live_status"] = "ended_no_step_endpoint"
                            vars["live_frames"] = "$frames"
                            return@withContext RunResult(true, vars.toMap(), shots, null)
                        }
                    } else {
                        step404s = 0
                        if (cmd.optBoolean("stop", false)) {
                            vars["live_status"] = "stopped"
                            vars["live_frames"] = "$frames"
                            return@withContext RunResult(true, vars.toMap(), shots, null)
                        }
                        val stepObj = cmd.optJSONObject("step")
                        if (stepObj != null) {
                            step(frames, "live-exec:${stepObj.optString("action", "?")}")
                            val stepShots = mutableListOf<File>()
                            try {
                                execStep(stepObj, stepShots)
                                shots += stepShots
                                vars["live_last_step"] =
                                    "${stepObj.optString("action", "?")}:ok".take(120)
                            } catch (e: Exception) {
                                vars["live_last_step"] =
                                    "${stepObj.optString("action", "?")}:fail:${e.message}".take(200)
                                // single step fail = loop continue (server ko
                                // frame vars me dikhega); action-block ho to
                                // loop se bahar (wahi 24h guard).
                                if ((e.message ?: "").contains("action blocked")) throw e
                            }
                        }
                    }
                    // 3) action-block guard (standing rule)
                    try { checkActionBlock() } catch (e: Exception) { throw e }
                    delay(LIVE_SESSION_CADENCE_MS)
                }
                vars["live_status"] = "timeout_30min"
                vars["live_frames"] = "$frames"
                RunResult(true, vars.toMap(), shots, "live session 30-min cap — normal exit")
            } catch (e: Exception) {
                vars["live_status"] = "failed"
                RunResult(false, vars.toMap(), shots, e.message)
            }
        }

    /**
     * Live frame: WebView draw → 540px wide scale → JPEG q60, ≤200KB tak
     * quality ghatao → base64 (NO_WRAP). Design doc §3.4 ka format.
     */
    private suspend fun captureLiveFrame(): String = withContext(Dispatchers.Main) {
        val w = if (webView.width > 0) webView.width else 1080
        val h = if (webView.height > 0) webView.height else 1920
        val full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        webView.draw(Canvas(full))
        val sw = 540
        val sh = maxOf(1, (h * sw / w))
        val scaled = Bitmap.createScaledBitmap(full, sw, sh, true)
        full.recycle()
        val baos = java.io.ByteArrayOutputStream()
        var q = 60
        scaled.compress(Bitmap.CompressFormat.JPEG, q, baos)
        while (baos.size() > 200 * 1024 && q > 20) {
            baos.reset()
            q -= 10
            scaled.compress(Bitmap.CompressFormat.JPEG, q, baos)
        }
        scaled.recycle()
        android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP)
    }

    // ---------- WebView primitives (Main thread) ----------

    /**
     * p18 STALL SAFETY (p57: 5 min — user order 2026-09-21): page load pe
     * timeout — onPageFinished kabhi na aaye (hang) to job yahin atak jata
     * tha; ab timeout pe seedha fail hota hai. Vercel USA relay se page
     * reload me time lagta hai, isliye 60s se badha ke 5 min kiya.
     * Saath me onRenderProcessGone: renderer crash pe flag set (app crash NAHI
     * hogi — default behavior app process ko maarta hai; hum return true karke
     * job ko fail-mark karte hain taaki server ko report jaye).
     */
    private var pageLoadTimedOut = false

    private suspend fun loadUrl(url: String) {
        pageLoadTimedOut = false
        val h = Handler(Looper.getMainLooper())
        suspendCancellableCoroutine<Unit> { cont ->
            var done = false
            fun finish(timedOut: Boolean) {
                if (done || !cont.isActive) return
                done = true
                pageLoadTimedOut = timedOut
                cont.resume(Unit)
            }
            val timeout = Runnable { finish(true) }
            h.postDelayed(timeout, PAGE_LOAD_TIMEOUT_MS)
            cont.invokeOnCancellation { h.removeCallbacks(timeout) }
            webView.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, u: String?) {
                    h.removeCallbacks(timeout)
                    // p44: full-app USA egress — HAR page pe JS interceptor
                    // install (koi host filter nahi). Switch OFF pe injectJs
                    // kuch nahi karta (seedha direct).
                    com.clipflow.agent.net.UsEgress.injectJs(view, store)
                    // p61: automation WebView pe page load → session-TOKEN sync
                    // (whop/contentrewards cookies → server, USA reads ke liye).
                    // MainActivity WebView wala hook yahan nahi chalta, isliye
                    // engine WebView me bhi — navigate job se sync trigger ho.
                    try { com.clipflow.agent.net.SessionTokenSync.maybeSyncForUrl(context, store, u) } catch (_: Exception) { }
                    finish(false)
                    finish(false)
                }
                // p44: FULL-APP USA egress — har GET (main-frame + subresource,
                // koi bhi host) Vercel (Virginia, USA) se. Non-GET native →
                // blocked page (backstop; in-page POSTs JS interceptor se
                // body samet proxy hote hain). Fail → blocked page
                // (fail-closed). Background thread pe chalta hai, isliye
                // blocking proxyFetch safe hai.
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: android.webkit.WebResourceRequest?
                ): android.webkit.WebResourceResponse? {
                    return try {
                        com.clipflow.agent.net.UsEgress.intercept(request, store)
                    } catch (e: Exception) {
                        // p45 fail-closed: proxy ON pe intercept exception =
                        // blocked page (India IP se chup-chaap direct leak nahi).
                        // Proxy OFF pe null = purana direct behavior.
                        val proxyOn = try { store.usaProxyEnabled() } catch (_: Exception) { false }
                        if (proxyOn) com.clipflow.agent.net.UsEgress.blockedResponse(
                            "intercept exception: ${(e.message ?: "unknown").take(120)}"
                        ) else null
                    }
                }
                override fun onReceivedError(v: WebView?, req: android.webkit.WebResourceRequest?, err: android.webkit.WebResourceError?) {
                    h.removeCallbacks(timeout)
                    finish(false) // page tooti bhi to aage badho; step fail hoga to detect hoga
                }
                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: android.webkit.RenderProcessGoneDetail?
                ): Boolean {
                    rendererCrashed = true
                    h.removeCallbacks(timeout)
                    finish(true)
                    return true // app ko mat maaro — job fail-mark hogi aur report jayegi
                }
            }
            webView.loadUrl(url)
        }
        if (pageLoadTimedOut) {
            throw Exception(
                if (rendererCrashed) "WebView renderer crash ho gaya (page load ke dauraan) — job fail-mark ki gayi"
                else "page load timeout (60s): $url"
            )
        }
    }

    /**
     * p47 SPEED: fixed delay(2500/3000) ki jagah smart settle wait.
     * Page ka document.readyState poll karta hai (har 250ms) — 'complete'
     * hote hi sirf 700ms JS settle karke aage badhta hai. Fast page pe
     * ~1s me nikal jata hai (pehle 2.5-3s fixed tha). Slow page pe max
     * 4s tak wait karta hai (fail-safe). Soch-samajh ke tez — safety intact.
     */
    private suspend fun waitForSettle(maxMs: Long = 4000L) {
        val start = System.currentTimeMillis()
        // Phase 1: document ready hone tak poll (max maxMs - 700ms)
        while (System.currentTimeMillis() - start < maxMs - 700) {
            val state = try { jsStr("document.readyState") } catch (_: Exception) { null }
            if (state == "complete") break
            delay(250)
        }
        // Phase 2: JS render ke liye chhota settle
        delay(700)
    }


    /**
     * Round-7 (Worker A): evaluateJavascript ka callback kabhi na aaye
     * (renderer dead, JS context toota) to 30s me fail — hamesha ke liye
     * hang nahi. Yehi purane build ka ek silent-death rasta tha.
     */
    private suspend fun jsStr(js: String): String? {
        try {
            return withTimeout(JS_EVAL_TIMEOUT_MS) {
                suspendCancellableCoroutine { cont ->
                    webView.evaluateJavascript(js) { raw ->
                        // evaluateJavascript JSON-escaped string deta hai: "text" ya null
                        val v = raw?.let {
                            if (it == "null") null
                            else if (it.length >= 2 && it.startsWith("\"")) it.substring(1, it.length - 1)
                                .replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n")
                            else it
                        }
                        if (cont.isActive) cont.resume(v)
                    }
                }
            }
        } catch (e: TimeoutCancellationException) {
            throw Exception("js eval timeout (30s) — page jawab nahi de rahi: ${js.take(120)}")
        }
    }

    private suspend fun jsBool(js: String): Boolean {
        return jsStr("JSON.stringify(!!($js))") == "true"
    }

    // ---------- JS builders ----------

    private fun selJs(s: JSONObject): String {
        val by = s.optString("by", "css")
        val v = q(s.optString("value"))
        return when (by) {
            "aria" -> "document.querySelector('[aria-label=' + $v + ']')"
            "text" -> """(function(){var els=[...document.querySelectorAll('button,a,[role=button]')];var f=els.find(e=>(e.innerText||'').trim()===$v);if(f)return f;var all=[...document.querySelectorAll('*')];return all.find(e=>e.childElementCount===0&&(e.innerText||'').trim()===$v)||null;})()"""
            // p64: case-insensitive REGEX text match — desktop/mobile UI
            // variants dono cover ("Select from computer|device" jaise).
            // value ek JS regex source hai, bina slashes ke.
            "text-regex" -> """(function(){var re;try{re=new RegExp($v,'i')}catch(e){return null}var els=[...document.querySelectorAll('button,a,[role=button]')];var f=els.find(function(e){return re.test((e.innerText||'').trim())});if(f)return f;var all=[...document.querySelectorAll('*')];return all.find(function(e){return e.childElementCount===0&&re.test((e.innerText||'').trim())})||null;})()"""
            else -> "document.querySelector($v)"
        }
    }

    private fun clickJs(s: JSONObject): String =
        "(function(){var el=${selJs(s)};if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;})()"

    private fun typeJs(s: JSONObject, text: String): String {
        val t = q(text)
        return """(function(){var el=${selJs(s)};if(!el)return false;el.focus();
try{document.execCommand('selectAll',false,null);}catch(e){}
var ok=false;
try{ok=document.execCommand('insertText',false,$t);}catch(e){}
if(!ok){var proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,$t);
el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
return true;})()""".trimIndent().replace("\n", "")
    }

    // ---------- helpers ----------

    private fun fill(t: String): String {
        var out = t
        vars.forEach { (k, v) -> out = out.replace("{{$k}}", v) }
        return out
    }

    private fun q(s: String): String =
        JSONObject.quote(s)

    private suspend fun download(url: String, dest: File) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url).build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw Exception("download HTTP ${resp.code}")
            FileOutputStream(dest).use { out ->
                resp.body!!.byteStream().copyTo(out)
            }
        }
    }

    private suspend fun screenshot(dest: File): File = withContext(Dispatchers.Main) {
        // hidden WebView INVISIBLE rakho lekin laid-out (1080x1920) taaki draw() kaam kare
        val w = if (webView.width > 0) webView.width else 1080
        val h = if (webView.height > 0) webView.height else 1920
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        webView.draw(canvas)
        withContext(Dispatchers.IO) {
            // p50: report upload Vercel 4.5MB limit me rahe — 720px JPEG q75
            // (pehle full-size PNG tha; bada multipart report hi nahi pahunchta tha).
            val sw = 720
            val sh = maxOf(1, (h * (sw.toFloat() / w)).toInt())
            val scaled = Bitmap.createScaledBitmap(bmp, sw, sh, true)
            try {
                FileOutputStream(dest).use {
                    scaled.compress(Bitmap.CompressFormat.JPEG, 75, it)
                }
            } finally {
                try { scaled.recycle() } catch (_: Exception) { }
                try { bmp.recycle() } catch (_: Exception) { }
            }
        }
        dest
    }

    /** File chooser ko automation ke file se auto-answer karta hai. */
    inner class AutomationChromeClient : WebChromeClient() {
        @Volatile var pendingFile: File? = null
        @Volatile var served: Boolean = false

        // p35: camera/mic getUserMedia hamesha silently deny — koi system
        // prompt nahi. Upload file chooser se hota hai (neeche), jise ye
        // permission chahiye hi nahi. Pehle jaise: zero prompts.
        override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
            request.deny()
        }

        override fun onShowFileChooser(
            view: WebView?, filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            val f = pendingFile
            served = true
            Handler(Looper.getMainLooper()).post {
                if (f != null && f.exists()) {
                    // FileProvider content:// URI (file:// API 24+ pe risky)
                    val uri = try {
                        androidx.core.content.FileProvider.getUriForFile(
                            context, "${context.packageName}.fileprovider", f
                        )
                    } catch (_: Exception) {
                        Uri.fromFile(f)
                    }
                    filePathCallback?.onReceiveValue(arrayOf(uri))
                } else {
                    filePathCallback?.onReceiveValue(null)
                }
            }
            pendingFile = null
            return true
        }
    }
}
