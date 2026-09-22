package com.clipflow.agent

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.content.res.Resources
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.net.ApiClient
import com.clipflow.agent.net.ApiException
import com.clipflow.agent.net.JobPoller
import com.clipflow.agent.net.PresenceClient
import com.clipflow.agent.net.UpdateChecker
import com.clipflow.agent.notify.Notifier
import com.clipflow.agent.web.LoginState
import com.clipflow.agent.web.LoginWebView
import com.clipflow.agent.work.JobPickup
import com.clipflow.agent.work.RunnerService
import com.clipflow.agent.work.Scheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder
import kotlin.math.abs

/**
 * p13 UI overhaul (round 3).
 *
 * Tabs (is order me): 🔍 Search | 🪙 Earn | 👤 Profile. Sab BADA UI.
 *
 * DESIGN: white premium clean — white background, rounded cards, accent
 * emerald-600 (#059669). Sab code-built, koi XML nahi. Sirf kaam ki cheezein
 * dikhti hain — internal/debug info (job IDs, version, technical notes) hata di.
 *
 *  - SEARCH: start page pe BADI Whop + Instagram login cards (status +
 *    tap karke login). Search/URL kholte hi FULL BROWSER mode (cards hide).
 *    🏠 Home button → wapas start page. Default search: Google.
 *    WebView EK BAAR banta hai — tab switch pe session intact.
 *    Neeche scroll → tab bar hide, upar scroll → wapas.
 *    Swipe: left→right = back, right→left = forward.
 *    System back = WebView back → start page → activity back.
 *  - EARN: submissions section (jaisa tha) + NEECHE "Coin Rewards":
 *    balance bada; 10min→100 coins SIRF EK BAAR; 2h→1000 / 4h→3000 UNLIMITED.
 *    Online time RunnerService ke 60s tick se (per-tick cap 120s, honest).
 *    views/earnings null ho to "—", KABHI fake number nahi.
 *  - PROFILE (exact order): (1) Device card — BADA 8-char code (44sp),
 *    (2) Status — Connected/Not connected + Last sync + Automation + Background,
 *    (3) Sleep button (alag), (4) Online button (alag),
 *    (5) Disconnect button → confirmation → NON-DISMISSIBLE code popup
 *    (back/outside-tap se band nahi hota; connect hone tak rehta hai).
 *    Delete device chhota neeche (functionality barkarar).
 *
 * SERVER FIXED: https://clipflow-webbuilder1.vercel.app — kahin bhi server
 * URL ka input NAHI dikhta. Enroll = sirf code.
 *
 * AUTOMATION GATE: RunnerService/Scheduler/poll TABHI jab enrolled + online
 * + Whop/IG dono login. Bina dono login automation band.
 *
 * Critical services same hain: RunnerService start, Scheduler 15-min poll,
 * launch pe immediate poll, FCM token register, cookie flush onPause/onDestroy,
 * notification permission, battery exemption request.
 */
class MainActivity : Activity() {

    companion object {
        const val ACCENT = "#059669" // emerald-600
        const val ACCENT_DARK = "#047857"
        const val INK = "#111827"
        const val MUTED = "#6B7280"
        const val CARD_BORDER = "#E5E7EB"
        const val DANGER = "#DC2626"
        const val WHOP_LOGIN_URL = LoginState.WHOP_LOGIN_URL
        const val IG_LOGIN_URL = LoginState.IG_LOGIN_URL
        // p13: Google wapas default search engine (user demand)
        const val GOOGLE_HOME = "https://www.google.com"
        const val GOOGLE_SEARCH = "https://www.google.com/search?q="
        const val FIXED_SERVER = "https://clipflow-webbuilder1.vercel.app"

        const val TAB_SEARCH = 0
        const val TAB_EARN = 1
        const val TAB_PROFILE = 2

        /** p18: foreground poll cadence — 10 sec (cadence ki wajah startFgPoll me). */
        private const val POLL_FG_MS = 10_000L
    }

    private lateinit var store: DeviceStore
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Tabs
    private lateinit var tabContent: FrameLayout
    private lateinit var tabBar: LinearLayout
    private val tabButtons = mutableListOf<Button>()
    private var currentTab = -1
    private var tabBarHidden = false

    // Search refs (EK BAAR bante hain — WebView kabhi dobara create nahi hota)
    private var searchView: View? = null
    private var searchWv: SwipeWebView? = null
    private var urlBar: EditText? = null
    private var startPage: LinearLayout? = null
    private var searchGateBanner: TextView? = null
    private var whopCardStatus: TextView? = null
    private var igCardStatus: TextView? = null
    private var lastScrollY = 0

    // Earn refs
    private var earnSummaryTv: TextView? = null
    private var earnList: LinearLayout? = null
    private var earnToken = 0

    private var connNote: String? = null
    private var serverReachable: Boolean? = null
    private var automationArmed = false

    // p18: real-time pickup — foreground fast poll + Profile live lines
    // P0 (2026-09-19): Worker C ki "Kaam:" text line ab proper active-job
    // CARD hai — wahi data source, wahi broadcast trigger, duplicate nahi.
    private var fgPollJob: Job? = null
    private var profilePollTv: TextView? = null
    private var profileJobCard: LinearLayout? = null
    private var profileJobTitle: TextView? = null
    private var profileJobDetail: TextView? = null
    // LIVE PREVIEW (2026-09-20): job chalte hue realtime screenshot
    private var profileLivePreview: android.widget.ImageView? = null
    private var livePreviewRunnable: Runnable? = null
    // p54 (2026-09-21): interactive LIVE — worker ka asli WebView yahan attach
    // hota hai; user khud bhi tap kar sakta hai (ManualDemo seekhta hai).
    private var liveWebHint: TextView? = null
    private var liveWebContainer: FrameLayout? = null
    // p68 (2026-09-22, user order): live preview ke upar browser navigation —
    // ◀ back, ▶ forward, ↻ reload. liveAttachedWv = abhi container me laga
    // hua worker ka WebView (detach pe null).
    private var liveWebNavRow: LinearLayout? = null
    private var liveAttachedWv: android.webkit.WebView? = null
    // p62 (2026-09-22): idle Seekhna — worker run ke bina bhi ASLI interactive
    // page. Standalone learn WebView (worker ke liveView se bilkul alag);
    // activity-level reference taaki tab rebuilds pe session intact rahe.
    // Run shuru hote hi worker ka live view (job card) takeover karta hai,
    // run khatm pe ye wapas aata hai.
    private var learnWv: com.clipflow.agent.web.AutomationWebView? = null
    private var learnLiveCard: LinearLayout? = null
    private var learnWebContainer: FrameLayout? = null
    private var learnUrlTv: TextView? = null
    // p68: learn WebView ke upar bhi ◀ ▶ ↻ navigation row.
    private var learnWebNavRow: LinearLayout? = null
    private var jobStateReceiver: android.content.BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            store = DeviceStore(this)
            Notifier.ensureChannel(this)
            requestNotificationPermission()
            registerJobStateReceiver()
            buildTabs()
            launchWiring()
            // Enrolled nahi → seedha Profile tab (wahan enroll dialog hai)
            selectTab(if (store.isEnrolled()) TAB_SEARCH else TAB_PROFILE)
        } catch (e: Exception) {
            val tv = TextView(this).apply {
                text = "Start me dikkat: ${e.message}\n\n${android.util.Log.getStackTraceString(e).take(2000)}"
                setPadding(32, 64, 32, 32)
                setTextIsSelectable(true)
            }
            setContentView(ScrollView(this).apply { addView(tv) })
        }
    }

    /**
     * BATTERY BUG FIX (p12): p11 me battery status sirf tab build hone pe
     * compute hota tha. User battery settings se wapas aata tha to purana
     * "restricted" hi dikhta rehta tha (stale UI). Ab onResume pe current tab
     * hamesha rebuild hota hai → isIgnoringBatteryOptimizations() fresh check.
     */
    override fun onResume() {
        super.onResume()
        if (::tabContent.isInitialized && currentTab >= 0) {
            val t = currentTab
            currentTab = -1
            selectTab(t)
        }
        startFgPoll()
        // WP5: jab tak update install na ho, har app open pe persistent popup
        maybeShowUpdatePopup()
    }

    /**
     * Notification tap (open_update=true) jab app pehle se khuli ho —
     * naya intent set karo taaki onResume ka popup-redirect use pakde.
     */
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        try { setIntent(intent) } catch (_: Exception) { }
    }

    /** Android 13+ pe notification permission runtime me mangni padti hai. */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101
                )
            }
        }
        // p35: camera/mic HATA DIYA — Instagram upload file chooser se hota
        // hai (onShowFileChooser), jise camera/mic permission chahiye hi
        // nahi. Pehle jaise: user se koi camera/mic access nahi manga jata.
        // WebView ke getUserMedia requests hamesha silently deny hote hain
        // (LoginWebView + JobEngine ke WebChromeClient me).
    }

    override fun onPause() {
        super.onPause()
        stopFgPoll()
        LoginWebView.flushCookies()
        // Dialog leak se bachao — onResume pe tab rebuild hoga to phir dikhega
        dismissEnrollDialog()
    }

    override fun onDestroy() {
        scope.cancel()
        stopFgPoll()
        try {
            jobStateReceiver?.let { unregisterReceiver(it) }
        } catch (_: Exception) { }
        jobStateReceiver = null
        LoginWebView.flushCookies()
        searchWv?.destroy()
        searchWv = null
        // p62: idle learn WebView destroy + idle recording band
        try { learnWv?.destroy() } catch (_: Exception) { }
        learnWv = null
        try { com.clipflow.agent.engine.ManualDemo.stopIdle() } catch (_: Exception) { }
        super.onDestroy()
    }

    /**
     * p18 — FOREGROUND fast poll: app khuli hai to har 10 sec jobs/next.
     * Kyun 10s: app foreground me hai to user active hai aur radio pehle se on
     * hai — chhota GET sasta hai; pickup latency ~10s (user ko wait nahi).
     * App band hote hi loop rukta hai (battery bachao) — background me
     * RunnerService ka 2-min poll + 15-min WorkManager backup sambhalte hain.
     * Gate/dedupe/notify sab JobPickup me (shared).
     */
    private fun startFgPoll() {
        stopFgPoll()
        if (!JobPickup.gateOk(this)) return
        fgPollJob = scope.launch(Dispatchers.IO) {
            while (isActive) {
                try {
                    JobPickup.pollAndStart(this@MainActivity)
                } catch (_: Exception) { }
                delay(POLL_FG_MS)
            }
        }
    }

    private fun stopFgPoll() {
        try {
            fgPollJob?.cancel()
        } catch (_: Exception) { }
        fgPollJob = null
    }

    /** p18: job state broadcast (poll/worker se) → Profile ki live lines refresh. */
    private fun registerJobStateReceiver() {
        if (jobStateReceiver != null) return
        jobStateReceiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                try {
                    refreshJobStatusLines()
                } catch (_: Exception) { }
            }
        }
        val filter = android.content.IntentFilter(JobPickup.ACTION_JOB_STATE)
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(jobStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                registerReceiver(jobStateReceiver, filter)
            }
        } catch (_: Exception) {
            jobStateReceiver = null
        }
    }

    /**
     * p18: Profile me live lines — poll "last checked" + active job card.
     * P0 (2026-09-19): job active ho to "⚡ Kaam chal raha hai" card dikhta hai
     * (current step + elapsed time); job khatam/fail ho to card HAT jata hai
     * (JobPickup.clearJob active record clear karta hai).
     * Update JobPickup ke broadcast pe live hoti hai (har step pe).
     */
    private fun refreshJobStatusLines() {
        val pollTv = profilePollTv ?: return
        val card = profileJobCard ?: return
        val last = store.lastPollCheck()
        pollTv.text = "Poll: " + if (last == 0L) "abhi tak nahi" else pollAgo(last)
        val a = store.getActiveJob()
        val st = a?.optString("status", "").orEmpty()
        val isActive = a != null && (st.startsWith("running") || st == "queued")
        if (!isActive) {
            card.visibility = View.GONE
            stopLivePreview()
            // p62: run nahi — idle Seekhna view wapas (Seekhna ON ho to)
            refreshIdleLearnVisibility(false)
            return
        }
        card.visibility = View.VISIBLE
        val type = a!!.optString("type", "automation").ifBlank { "automation" }
        val stepText = when {
            st.startsWith("running ") -> st.removePrefix("running ").trim().ifBlank { "chal raha hai…" }
            st == "running" -> "shuru ho raha hai…"
            st == "queued" -> "queue me hai, shuru hone wala hai…"
            else -> st.ifBlank { "chal raha hai…" }
        }
        profileJobTitle?.text = "⚡ Kaam chal raha hai ($type)"
        profileJobDetail?.text =
            "Step: $stepText\nShuru hue: ${elapsedSince(a.optLong("received_at", 0L))}"
        // p62: run active — worker ka live view takeover; idle learn chhupao
        refreshIdleLearnVisibility(true)
        // LIVE PREVIEW: job active hai → har 3 sec me screenshot refresh karo
        startLivePreview()
    }

    /**
     * p67 — proportional full-desktop fit: WebView ko uske asli 1920×1080
     * desktop layout pe rakho; sirf DISPLAY ko phone width ke hisaab se
     * proportionally scale karo (top-left pivot). Pura desktop viewport bina
     * clipping ke dikhta hai — agent ko pura page dikhega.
     *
     * Touch: view scale ke baad bhi Android touch events ko view ke inverse
     * matrix se map karta hai, isliye AutomationWebView.onTouchEvent me
     * event.x/event.y seedhe 1920×1080 virtual coordinates me aate hain —
     * ManualDemo recording bilkul sahi rehti hai. Automation viewport ko
     * phone-width par kabhi nahi badalte.
     */
    private fun desktopFitContext(): Context {
        return object : ContextWrapper(this) {
            private var fixedRes: Resources? = null
            override fun getResources(): Resources {
                fixedRes?.let { return it }
                val base = super.getResources()
                val m = DisplayMetrics().apply {
                    setTo(base.displayMetrics)
                    density = 1.0f
                    scaledDensity = 1.0f
                    densityDpi = DisplayMetrics.DENSITY_MEDIUM
                }
                return Resources(base.assets, m, Configuration(base.configuration))
                    .also { fixedRes = it }
            }
        }
    }

    private fun attachDesktopFitWebView(cont: FrameLayout, wv: WebView) {
        // WebView ka apna layout HAMESHA 1920×1080 px (automation viewport) —
        // phone-width MATCH_PARENT kabhi nahi (wahi clipping ki jad thi).
        if (wv.parent !== cont) {
            (wv.parent as? ViewGroup)?.removeView(wv)
            cont.removeAllViews()
            cont.addView(wv, FrameLayout.LayoutParams(1920, 1080))
        } else {
            val lp = wv.layoutParams as? FrameLayout.LayoutParams
            if (lp == null || lp.width != 1920 || lp.height != 1080) {
                wv.layoutParams = FrameLayout.LayoutParams(1920, 1080)
            }
        }
        // Display scale: container ki available width ke hisaab se, layout ke baad.
        cont.post { applyDesktopFitScale(cont, wv) }
    }

    private fun applyDesktopFitScale(cont: FrameLayout, wv: WebView) {
        try {
            val availW = (cont.width - cont.paddingLeft - cont.paddingRight)
                .takeIf { it > 0 } ?: return
            val scale = availW.toFloat() / 1920f
            wv.pivotX = 0f
            wv.pivotY = 0f
            wv.scaleX = scale
            wv.scaleY = scale
            // Wrapper height = scaled 1080, taaki pura viewport dikhe.
            val clp = cont.layoutParams
            if (clp != null) {
                clp.height = (1080f * scale).toInt().coerceAtLeast(1)
                cont.layoutParams = clp
            }
        } catch (_: Exception) { }
    }

    /**
     * p68 (2026-09-22, user order — "webview me back forward reload
     * navigation add kro"): interactive WebViews (live preview + learn)
     * ke upar browser-jaisi navigation row — ◀ back, ▶ forward, ↻ reload.
     * Search tab wali row jaisi styling. getWv har tap pe CURRENT WebView
     * deta hai (live preview me worker ka view attach/detach hota hai).
     */
    private fun makeWebNavRow(getWv: () -> android.webkit.WebView?): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(14), dp(4), dp(14), dp(6))
            visibility = View.GONE
        }
        fun navBtn(label: String): Button = Button(this).apply {
            text = label
            textSize = 15f
            setTextColor(Color.parseColor(ACCENT_DARK))
            background = roundedBg("#FFFFFF", 12, CARD_BORDER)
            minHeight = dp(52)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                .apply { setMargins(dp(4), 0, dp(4), 0) }
        }
        val backBtn = navBtn("◀")
        val fwdBtn = navBtn("▶")
        val reloadBtn = navBtn("↻")
        backBtn.setOnClickListener {
            try { val wv = getWv(); if (wv?.canGoBack() == true) wv.goBack() }
            catch (_: Exception) { }
        }
        fwdBtn.setOnClickListener {
            try { val wv = getWv(); if (wv?.canGoForward() == true) wv.goForward() }
            catch (_: Exception) { }
        }
        reloadBtn.setOnClickListener {
            try { getWv()?.reload() } catch (_: Exception) { }
        }
        row.addView(backBtn)
        row.addView(fwdBtn)
        row.addView(reloadBtn)
        return row
    }

    /**
     * LIVE PREVIEW (2026-09-20 — user order): Profile tab me realtime dikhe
     * app kya kar raha hai.
     * p54: "User se seekho" ON ho aur worker ka WebView available ho to
     * INTERACTIVE live dikhao — asli WebView attach hota hai, user khud bhi
     * tap kar sakta hai (ManualDemo seekhta hai). Nahi to purana static
     * screenshot preview (har 3 sec refresh).
     */
    private fun startLivePreview() {
        val iv = profileLivePreview ?: return
        // p54: interactive LIVE pehle
        val wv = try {
            com.clipflow.agent.work.AutomationViewHost.liveView
        } catch (_: Exception) {
            null
        }
        if (wv != null && store.learnFromUser()) {
            try {
                // static loop band — ab asli page dikhega
                livePreviewRunnable?.let {
                    android.os.Handler(android.os.Looper.getMainLooper())
                        .removeCallbacks(it)
                }
                livePreviewRunnable = null
                iv.visibility = View.GONE
                iv.setImageBitmap(null)
                liveWebHint?.visibility = View.VISIBLE
                val cont = liveWebContainer
                if (cont != null) {
                    cont.visibility = View.VISIBLE
                    // p67: WebView ko 1920x1080 par rakho, display ko proportionally scale karo.
                    attachDesktopFitWebView(cont, wv)
                    // p68: interactive live WebView pe back/forward/reload controls.
                    liveAttachedWv = wv
                    liveWebNavRow?.visibility = View.VISIBLE
                }
            } catch (_: Exception) { }
            return
        }
        // static preview pe wapas — attached WebView hatao
        liveAttachedWv = null
        liveWebNavRow?.visibility = View.GONE
        try {
            liveWebContainer?.removeAllViews()
        } catch (_: Exception) { }
        liveWebContainer?.visibility = View.GONE
        liveWebHint?.visibility = View.GONE
        if (livePreviewRunnable != null) return // pehle se chal raha hai
        iv.visibility = View.VISIBLE
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val r = object : Runnable {
            override fun run() {
                try {
                    val f = java.io.File(filesDir, "live_inapp.png")
                    if (f.exists() && f.length() > 0) {
                        val bmp = android.graphics.BitmapFactory.decodeFile(f.absolutePath)
                        if (bmp != null) {
                            iv.setImageBitmap(bmp)
                        }
                    }
                } catch (_: Exception) { }
                handler.postDelayed(this, 3000)
            }
        }
        livePreviewRunnable = r
        handler.post(r)
    }

    private fun stopLivePreview() {
        livePreviewRunnable?.let {
            android.os.Handler(android.os.Looper.getMainLooper()).removeCallbacks(it)
        }
        livePreviewRunnable = null
        profileLivePreview?.visibility = View.GONE
        profileLivePreview?.setImageBitmap(null)
        // p54: interactive live hatao — worker ka WebView destroy NAHI karte,
        // sirf detach (worker apne lifecycle me khud sambhalta hai).
        // p68: nav row bhi hatao.
        try {
            liveWebContainer?.removeAllViews()
        } catch (_: Exception) { }
        liveAttachedWv = null
        liveWebNavRow?.visibility = View.GONE
        liveWebContainer?.visibility = View.GONE
        liveWebHint?.visibility = View.GONE
    }

    /**
     * p62 — idle Seekhna learn WebView: EK BAAR banta hai (activity-level),
     * tab rebuilds pe re-attach hota hai (session intact). Worker ke
     * liveView se bilkul alag — AutomationWebView hai taaki taps ManualDemo
     * me record hon + page ko pass-through hon. Login cookies shared
     * (LoginWebView.setup) + USA-proxy wiring search tab jaisi.
     */
    private fun attachLearnWebView() {
        val cont = learnWebContainer ?: return
        var wv = learnWv
        if (wv == null) {
            // p67: seekhne wala WebView bhi asli 1920x1080 desktop viewport par —
            // density 1.0 wrapper taaki page desktop layout me render ho.
            wv = com.clipflow.agent.web.AutomationWebView(desktopFitContext())
            com.clipflow.agent.web.LoginWebView.setup(wv)
            // p44-style USA egress (search tab jaisa) — Whop region-block se
            // bachne ke liye learn page bhi proxy se jayega (fail-closed).
            try {
                wv.addJavascriptInterface(
                    com.clipflow.agent.net.UsEgressBridge(store), "__usProxy")
            } catch (_: Exception) { }
            wv.webViewClient = object : android.webkit.WebViewClient() {
                override fun onRenderProcessGone(
                    view: android.webkit.WebView?,
                    detail: android.webkit.RenderProcessGoneDetail?
                ): Boolean {
                    // p50 jaisa protection — app mat girao, page reload karo.
                    try {
                        Toast.makeText(this@MainActivity,
                            "Page reload ho raha hai…", Toast.LENGTH_SHORT).show()
                        view?.reload()
                    } catch (_: Exception) { }
                    return true
                }
                override fun shouldInterceptRequest(
                    view: android.webkit.WebView?,
                    request: android.webkit.WebResourceRequest?
                ): android.webkit.WebResourceResponse? {
                    return try {
                        com.clipflow.agent.net.UsEgress.intercept(request, store)
                    } catch (e: Exception) {
                        val proxyOn = try { store.usaProxyEnabled() }
                            catch (_: Exception) { false }
                        if (proxyOn) com.clipflow.agent.net.UsEgress.blockedResponse(
                            "intercept exception: ${(e.message ?: "unknown").take(120)}"
                        ) else null
                    }
                }
                override fun onPageFinished(
                    view: android.webkit.WebView?, url: String?
                ) {
                    super.onPageFinished(view, url)
                    try {
                        com.clipflow.agent.net.UsEgress.injectJs(view, store)
                    } catch (_: Exception) { }
                    if (!url.isNullOrBlank()) {
                        try { store.setLearnUrl(url) } catch (_: Exception) { }
                        try { learnUrlTv?.text = url.take(80) } catch (_: Exception) { }
                    }
                }
            }
            learnWv = wv
            try { wv.loadUrl(store.getLearnUrl()) } catch (_: Exception) { }
        }
        try {
            // p67: seekhne wala WebView bhi 1920x1080 par, display proportionally scaled.
            attachDesktopFitWebView(cont, wv)
            learnUrlTv?.text = try { wv.url?.take(80) } catch (_: Exception) { null }
                ?: try { store.getLearnUrl().take(80) } catch (_: Exception) { "" }
        } catch (_: Exception) { }
    }

    /**
     * p62 — idle learn card dikhao/chhupao. Run active ho to worker ka live
     * view (job card) takeover karta hai → ye chhupta hai + idle recording
     * band. Run khatm / idle + Seekhna ON → ye wapas + idle recording chalu.
     */
    private fun refreshIdleLearnVisibility(jobActive: Boolean) {
        val card = learnLiveCard ?: return
        val show = !jobActive && try { store.learnFromUser() }
            catch (_: Exception) { false }
        card.visibility = if (show) View.VISIBLE else View.GONE
        try { learnWebContainer?.visibility = if (show) View.VISIBLE else View.GONE }
        catch (_: Exception) { }
        // p68: idle learn WebView ke liye back/forward/reload controls.
        try { learnWebNavRow?.visibility = if (show) View.VISIBLE else View.GONE }
        catch (_: Exception) { }
        if (show) {
            attachLearnWebView()
            try { com.clipflow.agent.engine.ManualDemo.startIdle(this) }
            catch (_: Exception) { }
        } else {
            try { com.clipflow.agent.engine.ManualDemo.stopIdle() }
            catch (_: Exception) { }
        }
    }

    /** received_at se ab tak ka waqt — "3 min 20 sec" jaisa. */
    private fun elapsedSince(ts: Long): String {
        if (ts == 0L) return "pata nahi"
        val s = (System.currentTimeMillis() - ts) / 1000
        return when {
            s < 0 -> "abhi-abhi"
            s < 60 -> "$s sec"
            s < 3600 -> "${s / 60} min ${s % 60} sec"
            else -> "${s / 3600} h ${(s % 3600) / 60} min"
        }
    }

    private fun pollAgo(ts: Long): String {
        if (ts == 0L) return "kabhi nahi"
        val s = (System.currentTimeMillis() - ts) / 1000
        return when {
            s < 5 -> "abhi-abhi"
            s < 60 -> "$s sec pehle"
            else -> timeAgo(ts)
        }
    }

    /**
     * Search tab me WebView ka back: pehle page-back, phir start page,
     * phir activity-back.
     */
    override fun onBackPressed() {
        val wv = searchWv
        if (currentTab == TAB_SEARCH && wv != null && isBrowserMode()) {
            if (wv.canGoBack()) {
                wv.goBack()
            } else {
                goStartPage()
            }
        } else {
            super.onBackPressed()
        }
    }

    // ---------- In-app auto-update (WP5 persistent popup) ----------

    /**
     * WP5 (2026-09-20): jab tak update install na ho, har app open pe
     * persistent popup (UpdateActivity — non-cancelable, back blocked,
     * koi Cancel/"Baad me" nahi). Notification tap (open_update=true) bhi
     * seedha isi popup pe redirect hota hai.
     *
     * UpdateActivity khud verify karke finish ho jayegi agar naya kuch nahi
     * (race), isliye yahan false-positive launch harmless hai.
     *
     * p53: popup SIRF idle pe — run active ho to skip (agli app-open pe retry).
     */
    private fun maybeShowUpdatePopup() {
        if (UpdateActivity.isShowing) return
        scope.launch(Dispatchers.IO) {
            try {
                val forceOpen = intent.getBooleanExtra("open_update", false)
                if (forceOpen) {
                    try { intent.removeExtra("open_update") } catch (_: Exception) { }
                }
                val rel = try {
                    UpdateChecker.checkForEvent(this@MainActivity)
                } catch (_: Exception) { null }
                val pend = try { store.getPendingUpdate() } catch (_: Exception) { null }
                val pcode = pend?.optInt("code", 0) ?: 0
                if (pcode in 1..BuildConfig.VERSION_CODE) {
                    // stale pending (install ho chuka ya purana) — saaf karo
                    try { store.clearPendingUpdate() } catch (_: Exception) { }
                }
                val pfile = UpdateChecker.pendingApkFile(this@MainActivity)
                val pendingValid = pcode > BuildConfig.VERSION_CODE &&
                    pfile.exists() && pfile.length() > 100_000
                val needPopup = forceOpen || pendingValid ||
                    (rel != null && rel.isNewerThanInstalled())
                if (!needPopup) return@launch
                // p53 (2026-09-21, user order): automation active ho to update
                // popup ABHI NAHI — chahe pending download ho ya notification
                // tap. Run khatm hone ke baad agli app-open pe popup ayega;
                // tab tak progress screen block nahi hoti.
                if (!UpdateChecker.isIdle(this@MainActivity)) return@launch
                withContext(Dispatchers.Main) {
                    try {
                        startActivity(UpdateActivity.intent(this@MainActivity))
                    } catch (_: Exception) { }
                }
            } catch (_: Exception) { }
        }
    }

    // ---------- Design helpers ----------

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun roundedBg(color: String, radiusDp: Int, strokeColor: String? = null): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(Color.parseColor(color))
            strokeColor?.let { setStroke(dp(1), Color.parseColor(it)) }
        }
    }

    /** White card: rounded corners + subtle border + shadow. (p13: bada) */
    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = roundedBg("#FFFFFF", 18, CARD_BORDER)
        elevation = dp(3).toFloat()
        setPadding(dp(20), dp(20), dp(20), dp(20))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(dp(14), dp(8), dp(14), dp(8)) }
    }

    private fun sectionTitle(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor(INK))
        setPadding(0, 0, 0, dp(10))
    }

    /** Accent (emerald) button. (p13: bada, min height 60dp) */
    private fun accentBtn(text: String): Button = Button(this).apply {
        this.text = text
        setTextColor(Color.WHITE)
        textSize = 17f
        background = roundedBg(ACCENT, 14)
        setPadding(dp(18), dp(16), dp(18), dp(16))
        minHeight = dp(60)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, dp(6), 0, dp(6)) }
    }

    /** Outline button (emerald border/text). (p13: bada, min height 56dp) */
    private fun outlineBtn(text: String, color: String = ACCENT): Button = Button(this).apply {
        this.text = text
        setTextColor(Color.parseColor(color))
        textSize = 16f
        background = roundedBg("#FFFFFF", 14, color)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        minHeight = dp(56)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, dp(6), 0, dp(6)) }
    }

    private fun styledInput(hint: String): EditText = EditText(this).apply {
        this.hint = hint
        textSize = 16f
        background = roundedBg("#F9FAFB", 12, CARD_BORDER)
        setPadding(dp(16), dp(16), dp(16), dp(16))
        minHeight = dp(56)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, dp(6), 0, dp(6)) }
    }

    private fun infoText(): TextView = TextView(this).apply {
        textSize = 16f
        setTextColor(Color.parseColor(INK))
        setTextIsSelectable(true)
        setLineSpacing(dp(3).toFloat(), 1f)
    }

    private fun mutedText(s: String): TextView = TextView(this).apply {
        text = s
        textSize = 14f
        setTextColor(Color.parseColor(MUTED))
        setPadding(0, 0, 0, dp(10))
    }

    /** Horizontal progress bar: emerald fill + light track. (p13) */
    private fun progressBar(progress: Float): LinearLayout {
        val p = progress.coerceIn(0f, 1f)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = roundedBg("#E5E7EB", 8)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(14)
            ).apply { setMargins(0, dp(8), 0, dp(8)) }
            addView(View(this@MainActivity).apply {
                background = roundedBg(ACCENT, 8)
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, p)
            })
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f - p)
            })
        }
    }

    // ---------- Tab bar ----------

    private fun buildTabs() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F9FAFB"))
        }
        tabContent = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        tabBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
            elevation = dp(8).toFloat()
            setPadding(0, dp(6), 0, dp(6))
        }
        val labels = arrayOf("🔍 Search", "🪙 Earn", "👤 Profile")
        for (i in labels.indices) {
            val b = Button(this).apply {
                text = labels[i]
                textSize = 17f
                setPadding(0, dp(10), 0, dp(10))
                setBackgroundColor(Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { selectTab(i) }
            }
            tabButtons.add(b)
            tabBar.addView(b)
        }
        root.addView(tabContent)
        root.addView(tabBar)
        setContentView(root)
    }

    private fun selectTab(i: Int) {
        if (currentTab == i) {
            // Profile pe dobara tap + enrolled nahi → dialog dobara dikhao
            if (i == TAB_PROFILE && !store.isEnrolled()) showEnrollDialog()
            return
        }
        // Profile chhod rahe ho → enroll dialog band (wapas aane pe phir dikhega)
        if (currentTab == TAB_PROFILE) dismissEnrollDialog()
        currentTab = i
        // p18: purane tab ke live-line refs hatao (stale view update na ho)
        profilePollTv = null
        profileJobCard = null
        profileJobTitle = null
        profileJobDetail = null
        // p54: interactive live refs bhi (stale container me WebView na atke)
        try { liveWebContainer?.removeAllViews() } catch (_: Exception) { }
        liveWebHint = null
        liveWebContainer = null
        // p62: idle learn refs — WebView DESTROY NAHI (session intact rahe),
        // sirf container refs hatao; agle buildProfileView me re-attach hoga.
        learnLiveCard = null
        learnWebContainer = null
        learnUrlTv = null
        livePreviewRunnable = null
        showTabBar() // tab switch pe bar hamesha visible
        tabContent.removeAllViews()
        val v = when (i) {
            TAB_SEARCH -> getSearchView()
            TAB_EARN -> buildEarnView()
            else -> buildProfileView()
        }
        tabContent.addView(v)
        tabButtons.forEachIndexed { idx, b ->
            b.setTextColor(
                if (idx == i) Color.parseColor(ACCENT) else Color.parseColor("#9CA3AF")
            )
        }
        if (i == TAB_SEARCH) refreshSearchTab()
        if (i == TAB_PROFILE && !store.isEnrolled()) showEnrollDialog()
        // Browser Agent v1 (2026-09-21): Profile tab resume → session sync
        // trigger (design doc trigger #3). Best-effort, background me.
        if (i == TAB_PROFILE && store.isEnrolled()) {
            scope.launch(Dispatchers.IO) {
                try { com.clipflow.agent.net.SessionSync.sync(this@MainActivity, store) }
                catch (_: Exception) { }
            }
        }
    }

    private fun hideTabBar() {
        if (tabBarHidden) return
        tabBarHidden = true
        tabBar.animate().translationY(tabBar.height.toFloat()).setDuration(180)
            .withEndAction { tabBar.visibility = View.GONE }
    }

    private fun showTabBar() {
        if (!tabBarHidden) return
        tabBarHidden = false
        tabBar.visibility = View.VISIBLE
        tabBar.animate().translationY(0f).setDuration(180)
    }

    // ---------- Login state (LoginState object — cookie best-effort) ----------

    /** Automation gate: dono login zaroori. */
    private fun loginsOk(): Boolean = LoginState.loginsOk()

    private fun loginStatusText(loggedIn: Boolean, anyCookies: Boolean): String = when {
        loggedIn -> "Logged in ✓"
        anyCookies -> "cookies mili"
        else -> "Login karo"
    }

    // ---------- Launch wiring + automation gate ----------

    private fun launchWiring() {
        automationArmed = false
        if (!store.isEnrolled()) {
            connNote = "📵 Enrolled nahi — Profile tab me code daal ke connect karo"
            serverReachable = null
            return
        }
        if (store.sleepMode()) {
            connNote = "💤 Sleep mode — server se contact band hai"
            return
        }
        startAutomationIfAllowed()
        registerFcmTokenOnLaunch()
    }

    /**
     * Automation gate: RunnerService + Scheduler + immediate poll TABHI jab
     * enrolled + online + Whop/IG dono login. Bina login kuch start nahi hota.
     */
    private fun startAutomationIfAllowed() {
        if (!store.isEnrolled() || store.sleepMode() || store.isDisconnected()) return
        if (!loginsOk()) {
            connNote = "🔐 Pehle Whop aur Instagram me login karo — tabhi automation chalegi"
            serverReachable = null
            return
        }
        automationArmed = true
        startForegroundService(Intent(this, RunnerService::class.java))
        Scheduler.schedule(this, 12)
        connNote = "⏳ Server se jud raha hai…"
        serverReachable = null
        scope.launch { immediatePoll() }
    }

    /** Automation poori tarah band karo (sleep/disconnect/delete pe). */
    private fun stopAutomation() {
        automationArmed = false
        try {
            Scheduler.cancel(this)
        } catch (_: Exception) { }
        try {
            stopService(Intent(this, RunnerService::class.java))
        } catch (_: Exception) { }
    }

    private suspend fun immediatePoll() {
        try {
            val job = withContext(Dispatchers.IO) { JobPoller(store).nextJob() }
            store.setLastSync(System.currentTimeMillis())
            store.setDisconnected(false)
            serverReachable = true
            if (job != null) {
                connNote = "✅ Server se jud gaya — kaam mila, automation chalu ho rahi hai"
                JobPickup.startAutomation(this, job.id, job.type)
            } else {
                store.saveLastRun("poll", "ok-no-job", System.currentTimeMillis(), "poll")
                connNote = "✅ Server se jud gaya — abhi koi kaam nahi"
            }
        } catch (e: ApiException) {
            serverReachable = false
            if (e.code == 401) {
                store.setDisconnected(true)
                store.saveLastRun("poll", "disconnected-401", System.currentTimeMillis(), "poll")
                stopAutomation()
                Notifier.deviceDisconnected(this)
                connNote = "🔴 Disconnected — server ne device ko nahi pehchana (401). " +
                    "Profile tab me naya code daal ke dobara connect karo."
            } else {
                connNote = "❌ Server se jud nahi paya: ${e.message}"
            }
        } catch (e: Exception) {
            serverReachable = false
            connNote = "❌ Server se jud nahi paya: ${e.message}"
        }
    }

    private fun registerFcmTokenOnLaunch() {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    val token = try { task.result } catch (_: Exception) { null }
                    if (!token.isNullOrBlank()) {
                        scope.launch(Dispatchers.IO) {
                            PresenceClient.registerFcmToken(this@MainActivity, token)
                        }
                    }
                }
        } catch (_: Throwable) {
            // Firebase init fail — polling backup chalta rahega
        }
    }

    // NOTE (p13): toggleSleep() hata diya — ab setSleep(true/false) do alag buttons se.

    // ---------- Battery (p12 bug fix) ----------

    /**
     * Root cause (p11): battery status sirf profile view build hone pe compute
     * hota tha. User battery settings me allow karke wapas aata tha to
     * onResume() profile view rebuild NAHI karta tha → purana "restricted" hi
     * dikhta rehta tha (stale UI). Fix: onResume() hamesha current tab rebuild
     * karta hai (upar dekho) → isIgnoringBatteryOptimizations() fresh check.
     *
     * Dusra angle (OEM): MIUI/ColorOS/FuntouchOS pe system exemption ke saath
     * alag "Autostart"/"Background activity" setting hoti hai — system API
     * "allowed" bhi bole to OEM background rok sakta hai. Isliye UI me dono
     * dikhta hai: system exemption status + OEM background settings ka button.
     */
    private fun isBatteryExempt(): Boolean {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(packageName)
        } catch (_: Exception) {
            false
        }
    }

    /** OEM ke autostart/background settings kholne ki koshish (best-effort). */
    private fun openBackgroundSettings() {
        val candidates = mutableListOf<Intent>()
        val man = Build.MANUFACTURER.lowercase()
        fun comp(pkg: String, cls: String) = Intent().apply {
            component = ComponentName(pkg, cls)
        }
        when {
            man.contains("xiaomi") || man.contains("redmi") || man.contains("poco") -> {
                candidates += comp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
                candidates += comp("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
            }
            man.contains("oppo") || man.contains("realme") || man.contains("oneplus") -> {
                candidates += comp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
                candidates += comp("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity")
            }
            man.contains("vivo") || man.contains("iqoo") -> {
                candidates += comp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
                candidates += comp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")
            }
            man.contains("huawei") || man.contains("honor") -> {
                candidates += comp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
            }
            man.contains("samsung") -> {
                candidates += comp("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")
            }
        }
        // Generic: pehle system exemption request, phir battery optimization list
        candidates += Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        candidates += Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        for (intent in candidates) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) { }
        }
        Toast.makeText(
            this,
            "Settings nahi khul payi — Settings → Battery me khud allow karo",
            Toast.LENGTH_LONG
        ).show()
    }

    // ---------- 1) SEARCH tab ----------

    /** Swipe WebView: left→right swipe = browser back, right→left = browser forward. */
    private inner class SwipeWebView(context: Context) : WebView(context) {
        private val detector = GestureDetector(context,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onFling(
                    e1: MotionEvent?, e2: MotionEvent,
                    velocityX: Float, velocityY: Float
                ): Boolean {
                    if (e1 == null) return false
                    // Horizontal-dominant, tez fling hi navigation hai
                    if (abs(velocityX) > 600 && abs(velocityX) > abs(velocityY) * 1.5f) {
                        if (velocityX > 0) {
                            if (canGoBack()) { goBack(); return true }
                        } else {
                            if (canGoForward()) { goForward(); return true }
                        }
                    }
                    return false
                }
            })

        @Suppress("ClickableViewAccessibility")
        override fun onTouchEvent(event: MotionEvent): Boolean {
            return try {
                val handled = detector.onTouchEvent(event)
                handled || super.onTouchEvent(event)
            } catch (_: Exception) {
                try { super.onTouchEvent(event) } catch (_: Exception) { false }
            }
        }
    }

    /**
     * SEARCH tab (p13):
     *  - Start page (kuch search/navigate nahi kiya): BADI Whop + Instagram
     *    login cards — status + tap karke login.
     *  - Search/URL kholte hi FULL BROWSER mode: login cards HIDE.
     *  - 🏠 Home button → wapas start page (cards phir dikhenge).
     *  - Default search engine: Google (user demand).
     *  - Scroll neeche → tab bar hide, upar → show. Swipe L→R = back,
     *    R→L = forward. System back: pehle WebView back, phir start page,
     *    phir activity back.
     */
    private fun getSearchView(): View {
        searchView?.let { return it }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F9FAFB"))
        }

        // URL/search bar (bada)
        val barRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(14), dp(12), dp(14), dp(6))
        }
        urlBar = EditText(this).apply {
            hint = "Search ya URL likho"
            textSize = 16f
            imeOptions = EditorInfo.IME_ACTION_GO
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            background = roundedBg("#FFFFFF", 14, CARD_BORDER)
            elevation = dp(2).toFloat()
            setPadding(dp(16), dp(14), dp(16), dp(14))
            minHeight = dp(56)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_GO) {
                    openFromBar()
                    true
                } else false
            }
        }
        val goBtn = Button(this).apply {
            text = "Go"
            textSize = 16f
            setTextColor(Color.WHITE)
            background = roundedBg(ACCENT, 14)
            minHeight = dp(56)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(dp(8), 0, 0, 0) }
            setOnClickListener { openFromBar() }
        }
        barRow.addView(urlBar)
        barRow.addView(goBtn)
        layout.addView(barRow)

        // START PAGE: badi Whop + Instagram login cards (sirf shuru me)
        startPage = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        startPage!!.addView(TextView(this).apply {
            text = "Login status — tap karke login karo"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(INK))
            setPadding(dp(16), dp(10), dp(16), dp(6))
        })
        startPage!!.addView(bigLoginCard("Whop", WHOP_LOGIN_URL, true))
        startPage!!.addView(bigLoginCard("Instagram", IG_LOGIN_URL, false))
        startPage!!.addView(TextView(this).apply {
            text = "Upar search karo ya koi site kholo — browser mode me ye cards chhup jayenge."
            textSize = 14f
            setTextColor(Color.parseColor(MUTED))
            setPadding(dp(16), dp(10), dp(16), dp(4))
        })
        layout.addView(startPage)

        // Login gate banner — bina dono login ke automation band
        searchGateBanner = TextView(this).apply {
            text = "🔐 Pehle Whop aur Instagram me login karo — tabhi automation chalegi."
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(DANGER))
            setPadding(dp(16), dp(8), dp(16), dp(4))
        }
        layout.addView(searchGateBanner)

        // Home / Back / Forward / Reload row
        val navRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(14), dp(4), dp(14), dp(6))
        }
        fun navBtn(label: String): Button = Button(this).apply {
            text = label
            textSize = 15f
            setTextColor(Color.parseColor(ACCENT_DARK))
            background = roundedBg("#FFFFFF", 12, CARD_BORDER)
            minHeight = dp(52)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                .apply { setMargins(dp(4), 0, dp(4), 0) }
        }
        val homeBtn = navBtn("🏠")
        val backBtn = navBtn("◀")
        val fwdBtn = navBtn("▶")
        val reloadBtn = navBtn("↻")
        homeBtn.setOnClickListener { goStartPage() }
        backBtn.setOnClickListener { if (searchWv?.canGoBack() == true) searchWv?.goBack() }
        fwdBtn.setOnClickListener { if (searchWv?.canGoForward() == true) searchWv?.goForward() }
        reloadBtn.setOnClickListener { searchWv?.reload() }
        navRow.addView(homeBtn)
        navRow.addView(backBtn)
        navRow.addView(fwdBtn)
        navRow.addView(reloadBtn)
        layout.addView(navRow)

        // WebView — shuru me HIDDEN (start page dikhta hai); EK BAAR banta hai
        val wv = SwipeWebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
            visibility = View.GONE
        }
        LoginWebView.setup(wv)
        // p44: full-app USA egress — user ke search/login WebView ka HAR
        // request (har host) USA proxy se, fail-closed. Bridge JS
        // interceptor ke liye zaroori hai.
        try { wv.addJavascriptInterface(com.clipflow.agent.net.UsEgressBridge(store), "__usProxy") } catch (_: Exception) { }
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (url != null) urlBar?.setText(url)
                com.clipflow.agent.net.UsEgress.injectJs(view, store)
                refreshLoginCards()
                // Login abhi-abhi complete hua ho to gate khul sakta hai
                maybeUnlockAutomation()
                // Browser Agent v1 (2026-09-21): known site pe navigation
                // khatam → session sync trigger (debounced, 5 min/site).
                com.clipflow.agent.net.SessionSync.maybeSyncForUrl(this@MainActivity, store, url)
                // p60 (2026-09-21): user-authorized session-TOKEN sync
                // (whop/contentrewards cookies → server, USA reads ke liye).
                com.clipflow.agent.net.SessionTokenSync.maybeSyncForUrl(this@MainActivity, store, url)
            }
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
        }
        // Bottom tab bar scroll pe hide/show (neeche scroll → hide, upar → show)
        wv.viewTreeObserver.addOnScrollChangedListener {
            val y = wv.scrollY
            val dy = y - lastScrollY
            lastScrollY = y
            if (dy > 16 && y > 120) hideTabBar()
            else if (dy < -16) showTabBar()
        }
        searchWv = wv
        layout.addView(wv)

        searchView = layout
        refreshSearchTab()
        return layout
    }

    /** Badi tappable login card (start page): naam + status bada. */
    private fun bigLoginCard(name: String, loginUrl: String, isWhop: Boolean): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = roundedBg("#FFFFFF", 16, CARD_BORDER)
            elevation = dp(2).toFloat()
            setPadding(dp(20), dp(18), dp(20), dp(18))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(dp(14), dp(8), dp(14), dp(8)) }
            isClickable = true
            isFocusable = true
            gravity = Gravity.CENTER_VERTICAL
            setOnClickListener { openLoginInSearch(loginUrl) }
        }
        val textBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val title = TextView(this).apply {
            text = name
            textSize = 19f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(INK))
        }
        val status = TextView(this).apply {
            textSize = 15f
            setPadding(0, dp(4), 0, 0)
        }
        if (isWhop) whopCardStatus = status else igCardStatus = status
        textBox.addView(title)
        textBox.addView(status)
        val arrow = TextView(this).apply {
            text = "›"
            textSize = 32f
            setTextColor(Color.parseColor(ACCENT))
        }
        c.addView(textBox)
        c.addView(arrow)
        return c
    }

    /** Browser mode: start page chhupao, WebView dikhao. */
    private fun enterBrowserMode() {
        startPage?.visibility = View.GONE
        searchWv?.visibility = View.VISIBLE
    }

    /** Start page wapas: WebView chhupao, login cards dikhao. */
    private fun goStartPage() {
        searchWv?.visibility = View.GONE
        startPage?.visibility = View.VISIBLE
        showTabBar()
        refreshLoginCards()
    }

    /** Browser mode me hai ya start page pe? */
    private fun isBrowserMode(): Boolean = searchWv?.visibility == View.VISIBLE

    /** Search tab kholo aur login page load karo (browser mode me). */
    private fun openLoginInSearch(url: String) {
        selectTab(TAB_SEARCH)
        enterBrowserMode()
        try {
            searchWv?.loadUrl(url)
        } catch (e: Exception) {
            Toast.makeText(this, "Khul nahi paya: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    /** Login complete hote hi gate khula ho to automation start karo. */
    private fun maybeUnlockAutomation() {
        if (automationArmed) return
        if (!store.isEnrolled() || store.sleepMode() || store.isDisconnected()) return
        if (!loginsOk()) return
        connNote = "🔓 Dono login complete — automation start ho rahi hai"
        startAutomationIfAllowed()
        registerFcmTokenOnLaunch()
    }

    /** Search bar: valid URL → seedha kholo; warna Google pe search (p13). */
    private fun openFromBar() {
        val raw = urlBar?.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) return
        val target = when {
            raw.startsWith("http://") || raw.startsWith("https://") -> raw
            raw.contains(".") && !raw.contains(" ") -> "https://$raw"
            else -> GOOGLE_SEARCH + URLEncoder.encode(raw, "UTF-8")
        }
        enterBrowserMode()
        try {
            searchWv?.loadUrl(target)
        } catch (e: Exception) {
            Toast.makeText(this, "Khul nahi paya: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    /** Gate banner + login cards ka status refresh. */
    private fun refreshSearchTab() {
        val gateBlocked = store.isEnrolled() && !store.isDisconnected() &&
            !store.sleepMode() && !loginsOk()
        searchGateBanner?.visibility = if (gateBlocked) View.VISIBLE else View.GONE
        refreshLoginCards()
    }

    private fun refreshLoginCards() {
        val wOk = LoginState.whopLoggedIn()
        val iOk = LoginState.igLoggedIn()
        val wTxt = loginStatusText(wOk, LoginState.hasAnyCookies("https://whop.com/"))
        val iTxt = loginStatusText(iOk, LoginState.hasAnyCookies(IG_LOGIN_URL))
        whopCardStatus?.apply {
            text = wTxt
            textSize = 15f
            setTextColor(Color.parseColor(if (wOk) ACCENT else MUTED))
        }
        igCardStatus?.apply {
            text = iTxt
            textSize = 15f
            setTextColor(Color.parseColor(if (iOk) ACCENT else MUTED))
        }
    }

    // ---------- 2) EARN tab ----------

    private fun buildEarnView(): View {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F9FAFB"))
            setPadding(0, dp(6), 0, dp(6))
        }

        val summaryCard = card()
        summaryCard.addView(sectionTitle("Earnings summary"))
        earnSummaryTv = TextView(this).apply {
            text = "⏳ Load ho raha hai…"
            textSize = 14f
            setTextColor(Color.parseColor(MUTED))
        }
        summaryCard.addView(earnSummaryTv)
        layout.addView(summaryCard)

        val listTitle = TextView(this).apply {
            text = "Submissions"
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(INK))
            setPadding(dp(14), dp(8), dp(14), dp(4))
        }
        layout.addView(listTitle)

        earnList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        layout.addView(earnList)

        // ---------- Coin Rewards (p13) — submissions ke NEECHE, fixed ----------
        layout.addView(buildCoinSection())

        fetchEarnings()
        return ScrollView(this).apply { addView(layout) }
    }

    /**
     * Coin Rewards section (p13):
     *  - Balance bada, prominent.
     *  - Target 1: 10 min online → 100 coins — SIRF EK BAAR.
     *  - Target 2: 2 hours online → 1000 coins — UNLIMITED (har poore 2h block pe).
     *  - Target 3: 4 hours online → 3000 coins — UNLIMITED (har poore 4h block pe).
     *  "Online" = enrolled + sleep nahi + disconnected nahi + dono login
     *  (RunnerService ka 60s tick jama karta hai; per-tick cap 120s).
     */
    private fun buildCoinSection(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val balCard = card()
        balCard.addView(sectionTitle("🪙 Coin Rewards"))
        balCard.addView(TextView(this).apply {
            text = "${store.coinBalance()} coins"
            textSize = 34f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(ACCENT_DARK))
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, dp(4))
        })
        val totalMin = store.coinOnlineSec() / 60
        balCard.addView(TextView(this).apply {
            text = "Online time: ${formatOnlineTime(store.coinOnlineSec())}"
            textSize = 15f
            setTextColor(Color.parseColor(MUTED))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(4))
        })
        box.addView(balCard)

        // Target 1: 10 min → 100 coins, SIRF EK BAAR
        run {
            val claimed = store.coin10MinClaimed()
            val progMin = minOf(totalMin, 10)
            val claimable = store.coinOnlineSec() >= 600 && !claimed
            val c = card()
            c.addView(targetTitle("🎯 10 min online → 100 coins"))
            c.addView(mutedText("Sirf ek baar milega" + if (claimed) " — le liya ✓" else ""))
            c.addView(progressBar(progMin / 10f))
            c.addView(progressLabel("$progMin/10 min"))
            c.addView(claimButton("Claim 100 coins", claimable) {
                store.setCoin10MinClaimed()
                store.addCoins(100)
                Toast.makeText(this, "+100 coins! 🎉", Toast.LENGTH_LONG).show()
                rebuildEarnTab()
            })
            box.addView(c)
        }

        // Target 2: 2h → 1000 coins, UNLIMITED
        run {
            val blockSec = 2 * 3600L
            val doneBlocks = (store.coinOnlineSec() / blockSec).toInt()
            val avail = doneBlocks - store.coin2hClaimed()
            val inBlockMin = (store.coinOnlineSec() % blockSec) / 60
            val c = card()
            c.addView(targetTitle("🎯 2 hours online → 1000 coins"))
            c.addView(mutedText("Har poore 2 hours pe dobara — unlimited" +
                if (avail > 0) " • $avail claim ready!" else ""))
            c.addView(progressBar(inBlockMin / 120f))
            c.addView(progressLabel("$inBlockMin/120 min"))
            c.addView(claimButton(
                if (avail > 0) "Claim ${avail * 1000} coins ($avail×)" else "Claim 1000 coins",
                avail > 0
            ) {
                store.addCoin2hClaimed(avail)
                store.addCoins(1000L * avail)
                Toast.makeText(this, "+${avail * 1000} coins! 🎉", Toast.LENGTH_LONG).show()
                rebuildEarnTab()
            })
            box.addView(c)
        }

        // Target 3: 4h → 3000 coins, UNLIMITED
        run {
            val blockSec = 4 * 3600L
            val doneBlocks = (store.coinOnlineSec() / blockSec).toInt()
            val avail = doneBlocks - store.coin4hClaimed()
            val inBlockMin = (store.coinOnlineSec() % blockSec) / 60
            val c = card()
            c.addView(targetTitle("🎯 4 hours online → 3000 coins"))
            c.addView(mutedText("Har poore 4 hours pe dobara — unlimited" +
                if (avail > 0) " • $avail claim ready!" else ""))
            c.addView(progressBar(inBlockMin / 240f))
            c.addView(progressLabel("$inBlockMin/240 min"))
            c.addView(claimButton(
                if (avail > 0) "Claim ${avail * 3000} coins ($avail×)" else "Claim 3000 coins",
                avail > 0
            ) {
                store.addCoin4hClaimed(avail)
                store.addCoins(3000L * avail)
                Toast.makeText(this, "+${avail * 3000} coins! 🎉", Toast.LENGTH_LONG).show()
                rebuildEarnTab()
            })
            box.addView(c)
        }

        // Imaandaar note: coins ki koi cash value nahi — future token listing ka plan
        box.addView(TextView(this).apply {
            text = "ℹ️ Coins sirf reward points hain — inki koi cash value nahi hai. " +
                "Future me token listing ka plan hai, tab coins ka kya hoga ye wahan bataya jayega."
            textSize = 14f
            setTextColor(Color.parseColor(MUTED))
            setPadding(dp(18), dp(12), dp(18), dp(10))
            setLineSpacing(dp(3).toFloat(), 1f)
        })

        return box
    }

    private fun targetTitle(s: String): TextView = TextView(this).apply {
        text = s
        textSize = 17f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.parseColor(INK))
        setPadding(0, 0, 0, dp(4))
    }

    private fun progressLabel(s: String): TextView = TextView(this).apply {
        text = s
        textSize = 15f
        setTextColor(Color.parseColor(MUTED))
        setPadding(0, 0, 0, dp(4))
    }

    /** Claim button: claimable na ho to disabled (grey). */
    private fun claimButton(label: String, enabled: Boolean, onClaim: () -> Unit): Button {
        return Button(this).apply {
            text = label
            textSize = 16f
            minHeight = dp(56)
            isEnabled = enabled
            if (enabled) {
                setTextColor(Color.WHITE)
                background = roundedBg(ACCENT, 14)
            } else {
                setTextColor(Color.parseColor("#9CA3AF"))
                background = roundedBg("#F3F4F6", 14, CARD_BORDER)
            }
            alpha = if (enabled) 1f else 0.7f
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, dp(6), 0, dp(6)) }
            setOnClickListener { onClaim() }
        }
    }

    /** Earn tab rebuild (claim ke baad balance/progress fresh). */
    private fun rebuildEarnTab() {
        if (currentTab == TAB_EARN) {
            currentTab = -1
            selectTab(TAB_EARN)
        }
    }

    private fun formatOnlineTime(totalSec: Long): String {
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        return if (h > 0) "$h h $m min" else "$m min"
    }

    private fun fetchEarnings() {
        val token = ++earnToken
        if (!store.isEnrolled()) {
            earnSummaryTv?.text = "📵 Enrolled nahi — Profile tab me code daal ke connect karo."
            return
        }
        scope.launch {
            try {
                val json = withContext(Dispatchers.IO) { ApiClient.getEarnings(store) }
                if (token != earnToken || currentTab != TAB_EARN) return@launch
                renderEarnings(json)
            } catch (e: ApiException) {
                if (token != earnToken || currentTab != TAB_EARN) return@launch
                if (e.code == 401) {
                    store.setDisconnected(true)
                    earnSummaryTv?.text =
                        "🔴 Disconnected — Profile tab me naya code daal ke dobara connect karo."
                } else {
                    earnSummaryTv?.text = "❌ Load nahi hua: ${e.message}"
                }
                addRetryRow("Dobara try karo")
            } catch (e: Exception) {
                if (token != earnToken || currentTab != TAB_EARN) return@launch
                earnSummaryTv?.text = "❌ Load nahi hua: ${e.message}"
                addRetryRow("Dobara try karo")
            }
        }
    }

    private fun addRetryRow(label: String) {
        earnList?.addView(outlineBtn(label).apply {
            layoutParams = (layoutParams as LinearLayout.LayoutParams).apply {
                setMargins(dp(12), dp(6), dp(12), dp(6))
            }
            setOnClickListener { fetchEarnings() }
        })
    }

    private fun renderEarnings(json: org.json.JSONObject) {
        val totals = json.optJSONObject("totals")
        val subs = json.optJSONArray("submissions")
        val n = totals?.optInt("total_submissions", subs?.length() ?: 0) ?: (subs?.length() ?: 0)
        val sb = StringBuilder()
        sb.appendLine("Total submissions: $n")
        sb.appendLine(
            "Total views: " + if (totals == null || totals.isNull("total_views"))
                "—" else totals.optLong("total_views").toString()
        )
        sb.appendLine(
            "Est. earnings: " + if (totals == null || totals.isNull("total_estimated_earnings_usd"))
                "—" else "$" + String.format("%.2f", totals.optDouble("total_estimated_earnings_usd"))
        )
        earnSummaryTv?.apply {
            text = sb.toString().trimEnd()
            setTextColor(Color.parseColor(INK))
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
        }

        earnList?.removeAllViews()
        if (subs == null || subs.length() == 0) {
            earnList?.addView(mutedText("Abhi koi submission nahi hai.").apply {
                setPadding(dp(14), dp(4), dp(14), dp(4))
            })
            return
        }
        for (i in 0 until subs.length()) {
            val s = subs.optJSONObject(i) ?: continue
            val name = s.optString("campaign_name").ifBlank { s.optString("campaign_slug", "—") }
            val slug = s.optString("campaign_slug", "")
            val date = s.optString("submitted_at", "").take(10).ifBlank { "—" }
            val status = s.optString("whop_status", "—")
            val views = if (s.isNull("views")) "—" else s.optLong("views").toString()
            val earn = if (s.isNull("estimated_earnings_usd")) "—"
            else "$" + String.format("%.2f", s.optDouble("estimated_earnings_usd"))
            val reelUrl = s.optString("reel_url", "")

            val c = card()
            c.addView(TextView(this).apply {
                text = name
                textSize = 14f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.parseColor(INK))
            })
            if (slug.isNotBlank() && slug != name) {
                c.addView(mutedText(slug))
            }
            c.addView(TextView(this).apply {
                text = "📅 $date   •   Status: $status\n👁 $views views   •   💵 $earn"
                textSize = 13f
                setTextColor(Color.parseColor(INK))
                setPadding(0, dp(4), 0, dp(4))
            })
            if (reelUrl.isNotBlank()) {
                c.addView(outlineBtn("▶ Reel kholo").apply {
                    setOnClickListener {
                        try {
                            selectTab(TAB_SEARCH)
                            searchWv?.loadUrl(reelUrl)
                        } catch (e: Exception) {
                            Toast.makeText(
                                this@MainActivity, "Khul nahi paya: ${e.message}",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                })
            }
            earnList?.addView(c)
        }
    }

    // ---------- 3) PROFILE tab ----------

    /**
     * PROFILE tab (p13) — EXACT structure:
     *  1. Device card: sabse upar BADA 8-char code (website card wala hi number)
     *  2. Status: Connected / Not connected + Last sync (app↔website)
     *  3. Sleep button (alag) + Online button (alag)
     *  4. Disconnect button → confirmation → non-dismissible code popup
     * Sirf kaam ki cheezein — internal info (job IDs, version, technical notes) hata di.
     */
    private fun buildProfileView(): View {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F9FAFB"))
            setPadding(0, dp(8), 0, dp(8))
        }

        if (!store.isEnrolled()) {
            // Enrolled nahi → peeche KUCH NAHI; non-dismissible dialog alag se.
            return ScrollView(this).apply { addView(layout) }
        }

        val id = store.deviceId().orEmpty()
        val sleeping = store.sleepMode()
        val disconnected = store.isDisconnected()
        val connected = !disconnected
        val last = store.lastSync()
        val lastStr = if (last == 0L) "kabhi nahi" else timeAgo(last)

        // 1) Device card — BADA device number sabse upar
        // Browser Agent v1 (2026-09-21): server-assigned device_no ("AC-0007")
        // prominent. Purane enroll (bina device_no) pe device-id ka short fallback.
        val deviceNo = store.deviceNo()
        val deviceCard = card()
        deviceCard.addView(TextView(this).apply {
            text = deviceNo ?: id.take(8).uppercase()
            textSize = 44f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(ACCENT_DARK))
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, dp(6))
            letterSpacing = 0.12f
        })
        deviceCard.addView(TextView(this).apply {
            text = if (deviceNo != null) "Device $deviceNo" else id
            textSize = 13f
            setTextColor(Color.parseColor(MUTED))
            gravity = Gravity.CENTER
            setTextIsSelectable(true)
            setPadding(0, 0, 0, dp(2))
        })
        layout.addView(deviceCard)

        // 1b) Browser Agent v1 (2026-09-21): "Browser logins" — site-wise
        // login state (green/red dot + handle + last sync age). Cookie check
        // IO pe hota hai, isliye pehle placeholder, phir refresh.
        val loginsCard = card()
        loginsCard.addView(sectionTitle("🌐 Browser logins"))
        val loginsTv = infoText().apply { text = "check ho raha hai…" }
        loginsCard.addView(loginsTv)
        layout.addView(loginsCard)
        val loginsTag = Any()
        loginsTv.tag = loginsTag
        scope.launch(Dispatchers.IO) {
            val sites = com.clipflow.agent.net.SessionSync.collectStatus(this@MainActivity, store)
            val lines = sites.joinToString("\n") { s ->
                val dot = if (s.loggedIn) "🟢" else "🔴"
                val handle = if (!s.accountHandle.isNullOrEmpty()) " • ${s.accountHandle}" else ""
                val age = if (s.lastVerified > 0) " • sync ${timeAgo(s.lastVerified)}" else " • kabhi sync nahi"
                "$dot ${s.displayName}$handle$age"
            }
            withContext(Dispatchers.Main) {
                if (loginsTv.tag === loginsTag) loginsTv.text = lines
            }
        }

        // 2) Status — Connected/Not connected + Last sync + Automation + Background
        val statusCard = card()
        statusCard.addView(sectionTitle("Status"))
        val autoState = when {
            disconnected -> "OFF — disconnected"
            sleeping -> "OFF — sleep mode"
            !loginsOk() -> "OFF — login pending"
            automationArmed -> "ON"
            else -> "OFF"
        }
        val exempt = isBatteryExempt()
        statusCard.addView(infoText().apply {
            text = (if (connected) "● Connected" else "○ Not connected") +
                "\nLast sync: $lastStr" +
                "\nAutomation: $autoState" +
                "\nBackground: " + if (exempt) "ON" else "OFF"
        })
        // p18 REAL-TIME: poll "last checked" — JobPickup ke broadcast pe live
        profilePollTv = TextView(this).apply {
            textSize = 16f
            setTextColor(Color.parseColor(INK))
            setPadding(0, dp(6), 0, 0)
        }
        statusCard.addView(profilePollTv)
        if (!exempt) {
            statusCard.addView(outlineBtn("🔋 Background allow karo").apply {
                setOnClickListener { openBackgroundSettings() }
            })
        }
        layout.addView(statusCard)

        // p43 (2026-09-21): USA PROXY card — user-visible switch (default ON).
        // p63 (2026-09-22): per-host — ON = sirf Whop/Content Rewards USA se,
        // baaki sab (Instagram wagera) hamesha direct.
        // OFF = sab seedha direct (region block lag sakta hai).
        val proxyCard = card()
        proxyCard.addView(sectionTitle("🇺🇸 USA Proxy"))
        val proxyOn = store.usaProxyEnabled()
        val proxyRegion = store.usaProxyRegion()
        val proxyVerifiedAt = store.usaProxyVerifiedAt()
        val proxyStatusText = if (proxyOn) {
            "ON — Whop/Content Rewards USA se, baaki direct" +
                if (proxyRegion != null && proxyVerifiedAt > 0)
                    "\nLast verified: $proxyRegion • ${timeAgo(proxyVerifiedAt)}"
                else "\nAbhi tak verify nahi hua — agle page pe check hoga"
        } else {
            "OFF — Whop seedha chalega (region block lag sakta hai)"
        }
        proxyCard.addView(TextView(this).apply {
            text = proxyStatusText
            textSize = 15f
            setTextColor(Color.parseColor(INK))
            setPadding(0, 0, 0, dp(8))
        })
        proxyCard.addView(android.widget.Switch(this).apply {
            text = if (proxyOn) "USA Proxy ON" else "USA Proxy OFF"
            textSize = 17f
            isChecked = proxyOn
            setOnCheckedChangeListener { _, on ->
                store.setUsaProxyEnabled(on)
                Toast.makeText(
                    this@MainActivity,
                    if (on) "🇺🇸 USA Proxy ON — free USA proxy se chalega"
                    else "USA Proxy OFF — Whop direct chalega",
                    Toast.LENGTH_SHORT
                ).show()
                if (currentTab == TAB_PROFILE) {
                    currentTab = -1
                    selectTab(TAB_PROFILE)
                }
            }
        })
        layout.addView(proxyCard)

        // p54 (user order 2026-09-21): "User se seekho" — run ke dauraan LIVE
        // page pe user khud bhi tap kar sake; worker un taps ko turant follow
        // karega + seekh ke agli baar khud karega (local prefs + server
        // memory). Default ON. OFF = purana behavior (sirf static preview,
        // koi tap record nahi).
        val learnCard = card()
        learnCard.addView(sectionTitle("🧠 User se seekho"))
        val learnOn = store.learnFromUser()
        learnCard.addView(TextView(this).apply {
            text = "Run ke dauraan LIVE page pe aap bhi tap kar sakte ho — " +
                "worker wahi follow karega aur seekh ke agli baar khud karega."
            textSize = 15f
            setTextColor(Color.parseColor(INK))
            setPadding(0, 0, 0, dp(8))
        })
        learnCard.addView(android.widget.Switch(this).apply {
            text = if (learnOn) "Seekhna ON" else "Seekhna OFF"
            textSize = 17f
            isChecked = learnOn
            setOnCheckedChangeListener { _, on ->
                store.setLearnFromUser(on)
                Toast.makeText(
                    this@MainActivity,
                    if (on) "🧠 Seekhna ON — run me LIVE page pe aap bhi tap kar sakte ho"
                    else "Seekhna OFF — sirf worker kaam karega",
                    Toast.LENGTH_SHORT
                ).show()
                if (currentTab == TAB_PROFILE) {
                    currentTab = -1
                    selectTab(TAB_PROFILE)
                }
            }
        })
        layout.addView(learnCard)

        // p62 (2026-09-22, user order — "Seekhna ON pe tap karo to kuch nahi
        // hota"): Seekhna ON ho to Profile tab me ASLI interactive page —
        // worker run ka intezaar NAHI. Ye standalone learn WebView hai
        // (worker ke liveView se bilkul alag lifecycle); taps ManualDemo me
        // record hote hain (idle learning — har tap pe "✍️ Seekha" toast)
        // aur page ko pass-through hote hain. Run shuru hote hi worker ka
        // live view (neeche job card) takeover karta hai; run khatm hote hi
        // ye wapas aata hai. Login session shared hai (LoginWebView cookies).
        val llc = card()
        llc.addView(sectionTitle("🧠 Seekhna — live page"))
        llc.addView(TextView(this).apply {
            text = "Ye ASLI page hai — tap karo, worker seekhega ✍️ " +
                "(har tap pe toast ayega)"
            textSize = 14f
            setTextColor(Color.parseColor(INK))
            setPadding(0, 0, 0, dp(4))
        })
        learnUrlTv = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor(MUTED))
            setPadding(0, 0, 0, dp(4))
        }
        llc.addView(learnUrlTv)
        learnWebContainer = FrameLayout(this).apply { visibility = View.GONE }
        learnWebNavRow = makeWebNavRow { learnWv }
        llc.addView(learnWebNavRow)
        llc.addView(learnWebContainer)
        llc.visibility = View.GONE
        layout.addView(llc)
        learnLiveCard = llc

        // P0 (2026-09-19) ACTIVE JOB CARD: job active ho to clearly dikhe —
        // "⚡ Kaam chal raha hai" + current step + elapsed time.
        // Worker C ki purani "Kaam:" text line isi card me upgrade hui hai
        // (wahi data source + wahi broadcast trigger — duplicate nahi).
        // Job khatam/fail ho to card HAT jata hai (refreshJobStatusLines).
        profileJobCard = card().apply { visibility = View.GONE }
        profileJobTitle = TextView(this).apply {
            text = "⚡ Kaam chal raha hai"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor(ACCENT_DARK))
            setPadding(0, 0, 0, dp(6))
        }
        profileJobDetail = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.parseColor(INK))
            setLineSpacing(dp(3).toFloat(), 1f)
        }
        profileJobCard!!.addView(profileJobTitle)
        profileJobCard!!.addView(profileJobDetail)
        // LIVE PREVIEW (2026-09-20 — user order): job chalte hue app me hi
        // realtime dikhe kya ho raha hai. Worker har 3 sec me screenshot
        // save karta hai, ye ImageView har 3 sec me refresh hota hai.
        profileLivePreview = android.widget.ImageView(this).apply {
            adjustViewBounds = true
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            setPadding(0, dp(8), 0, 0)
            visibility = View.GONE
        }
        profileJobCard!!.addView(profileLivePreview)
        // p54: interactive LIVE view — worker ka asli WebView yahan attach
        // hoga jab run chal raha ho aur "User se seekho" ON ho.
        liveWebHint = TextView(this).apply {
            text = "👆 Ye LIVE page hai — aap bhi tap kar sakte ho. " +
                "Worker aapke taps se seekhega 🧠"
            textSize = 14f
            setTextColor(Color.parseColor(INK))
            setPadding(0, dp(8), 0, dp(4))
            visibility = View.GONE
        }
        profileJobCard!!.addView(liveWebHint)
        // p68: live preview ke upar ◀ ▶ ↻ navigation (worker ke WebView pe).
        liveWebNavRow = makeWebNavRow { liveAttachedWv }
        profileJobCard!!.addView(liveWebNavRow)
        liveWebContainer = FrameLayout(this).apply { visibility = View.GONE }
        profileJobCard!!.addView(liveWebContainer)
        layout.addView(profileJobCard)
        refreshJobStatusLines()

        // 3) Sleep button (alag) + Online button (alag)
        val sleepBtn = accentBtn("💤 Sleep").apply {
            isEnabled = !sleeping
            alpha = if (!sleeping) 1f else 0.45f
            setOnClickListener { setSleep(true) }
        }
        val onlineBtn = accentBtn("🟢 Online").apply {
            isEnabled = sleeping
            alpha = if (sleeping) 1f else 0.45f
            setOnClickListener { setSleep(false) }
        }
        layout.addView(sleepBtn)
        layout.addView(onlineBtn)

        // 4) Disconnect button
        layout.addView(outlineBtn("🔌 Disconnect", DANGER).apply {
            setOnClickListener { confirmDisconnect() }
        })

        // Delete — chhota, neeche (functionality barkarar, low profile)
        layout.addView(TextView(this).apply {
            text = "Delete device"
            textSize = 14f
            setTextColor(Color.parseColor(MUTED))
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(8))
            isClickable = true
            isFocusable = true
            setOnClickListener { confirmDeleteStep1() }
        })

        return ScrollView(this).apply { addView(layout) }
    }

    /**
     * Sleep / Online — do ALAG actions (p13, toggle nahi).
     * Sleep: automation band + service/scheduler stop.
     * Online: gate check ke saath automation start.
     */
    private fun setSleep(sleep: Boolean) {
        if (sleep) {
            stopAutomation()
            store.setSleepMode(true)
            scope.launch(Dispatchers.IO) {
                PresenceClient.postPresence(this@MainActivity, "sleeping")
            }
            Toast.makeText(this, "💤 Sleep mode", Toast.LENGTH_SHORT).show()
        } else {
            store.setSleepMode(false)
            scope.launch(Dispatchers.IO) {
                PresenceClient.postPresence(this@MainActivity, "online")
            }
            startAutomationIfAllowed()
            Toast.makeText(this, "🟢 Online", Toast.LENGTH_SHORT).show()
        }
        if (currentTab == TAB_PROFILE) {
            currentTab = -1
            selectTab(TAB_PROFILE)
        }
    }

    // ---------- Enroll dialog (enrolled nahi ho to SIRF ye) ----------

    /**
     * Enroll dialog (p13) — NON-DISMISSIBLE: back/outside-tap se band nahi hota.
     * Jab tak user website se naya code generate karke yahan daal ke connect
     * na kar le, ye Profile tab me bana rahta hai. Dusre tab pe jaane pe
     * temporarily dismiss hota hai; Profile pe wapas aate hi phir dikhta hai.
     */
    private var enrollDlg: AlertDialog? = null

    private fun showEnrollDialog() {
        if (store.isEnrolled()) return
        enrollDlg?.let {
            try {
                if (it.isShowing) return
            } catch (_: Exception) { }
        }
        val codeInput = styledInput("AutoClip code").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }
        val msg = TextView(this).apply {
            text = "Website → Devices → Add device se code copy karke yahan dalo.\n" +
                "Connect kiye bina aage nahi badh sakte."
            textSize = 15f
            setTextColor(Color.parseColor(MUTED))
            setPadding(0, 0, 0, dp(10))
        }
        val errTv = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.parseColor(DANGER))
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(4), dp(8), 0)
            addView(msg)
            addView(codeInput)
            addView(errTv)
        }
        val dlg = AlertDialog.Builder(this)
            .setTitle("AutoClip code dalo")
            .setView(box)
            .setPositiveButton("Connect", null) // neeche override — dismiss rokne ke liye
            .setCancelable(false) // back se band NAHI hoga
            .create()
        dlg.setCanceledOnTouchOutside(false) // bahar tap se band NAHI hoga
        enrollDlg = dlg
        dlg.show()
        dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val code = codeInput.text.toString().trim()
            if (code.length < 4) {
                errTv.text = "Code dalo (Devices → Add device)"
                return@setOnClickListener
            }
            it.isEnabled = false
            errTv.text = "Connect ho raha hai…"
            errTv.setTextColor(Color.parseColor(MUTED))
            scope.launch {
                try {
                    // Purana automation/schedule/service pehle band, phir naya enroll
                    withContext(Dispatchers.Main) { stopAutomation() }
                    // SERVER FIXED — code hi kaafi hai, URL input kahin nahi
                    val res = withContext(Dispatchers.IO) {
                        ApiClient.enroll(FIXED_SERVER, code)
                    }
                    store.save(res.deviceId, res.apiKey, FIXED_SERVER)
                    // Browser Agent v1 (2026-09-21): enroll response se
                    // device_no ("AC-0007") save — Profile tab me dikhega.
                    res.deviceNo?.let { store.setDeviceNo(it) }
                    withContext(Dispatchers.Main) {
                        try {
                            dlg.dismiss()
                        } catch (_: Exception) { }
                        enrollDlg = null
                    }
                    Toast.makeText(this@MainActivity, "Connected!", Toast.LENGTH_LONG).show()
                    launchWiring()
                    currentTab = -1
                    selectTab(TAB_PROFILE)
                } catch (e: Exception) {
                    errTv.text = "Fail: ${e.message}"
                    errTv.setTextColor(Color.parseColor(DANGER))
                    it.isEnabled = true
                }
            }
        }
    }

    private fun dismissEnrollDialog() {
        try {
            enrollDlg?.dismiss()
        } catch (_: Exception) { }
        enrollDlg = null
    }

    private fun confirmDisconnect() {
        AlertDialog.Builder(this)
            .setTitle("Disconnect device?")
            .setMessage(
                "Server ko bataya jayega aur ye phone unenroll ho jayega.\n\n" +
                    "Uske baad Profile me ek popup aayega jo tab tak rahega " +
                    "jab tak website se naya code lekar dobara connect na kar lo."
            )
            .setPositiveButton("Disconnect") { _, _ -> doDisconnect() }
            .setNegativeButton("Ruko", null)
            .show()
    }

    private fun doDisconnect() {
        Toast.makeText(this, "Disconnect ho raha hai…", Toast.LENGTH_SHORT).show()
        scope.launch(Dispatchers.IO) {
            try {
                ApiClient.disconnect(store)
            } catch (e: ApiException) {
                if (e.code != 401) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(
                            this@MainActivity, "Disconnect fail: ${e.message}", Toast.LENGTH_LONG
                        ).show()
                    }
                    return@launch
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(
                        this@MainActivity, "Disconnect fail: ${e.message}", Toast.LENGTH_LONG
                    ).show()
                }
                return@launch
            }
            withContext(Dispatchers.Main) { stopAutomation() }
            store.clearEnrollment()
            serverReachable = null
            connNote = "🔌 Disconnected — dobara connect ke liye Profile me naya code dalo"
            withContext(Dispatchers.Main) {
                currentTab = -1
                selectTab(TAB_PROFILE)
                Toast.makeText(this@MainActivity, "Disconnected", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun confirmDeleteStep1() {
        AlertDialog.Builder(this)
            .setTitle("Device delete karo?")
            .setMessage(
                "Server pe device SOFT-DELETE hoga (7 din tak restore ho sakta hai).\n\n" +
                    "Ye phone bhi unenroll ho jayega."
            )
            .setPositiveButton("Aage badho") { _, _ -> confirmDeleteStep2() }
            .setNegativeButton("Ruko", null)
            .show()
    }

    private fun confirmDeleteStep2() {
        AlertDialog.Builder(this)
            .setTitle("Pakka delete?")
            .setMessage("Ye aakhri confirm hai. Device server se delete ho jayega.")
            .setPositiveButton("Haan, delete karo") { _, _ -> doDelete() }
            .setNegativeButton("Ruko", null)
            .show()
    }

    private fun doDelete() {
        Toast.makeText(this, "Delete ho raha hai…", Toast.LENGTH_SHORT).show()
        scope.launch(Dispatchers.IO) {
            try {
                ApiClient.deleteDevice(store)
            } catch (e: ApiException) {
                if (e.code != 401) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(
                            this@MainActivity, "Delete fail: ${e.message}", Toast.LENGTH_LONG
                        ).show()
                    }
                    return@launch
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(
                        this@MainActivity, "Delete fail: ${e.message}", Toast.LENGTH_LONG
                    ).show()
                }
                return@launch
            }
            withContext(Dispatchers.Main) { stopAutomation() }
            store.clearEnrollment()
            serverReachable = null
            connNote = "🗑️ Device server pe delete ho gaya — Profile se naya code daal ke dobara connect karo"
            withContext(Dispatchers.Main) {
                currentTab = -1
                selectTab(TAB_PROFILE)
                Toast.makeText(this@MainActivity, "Device deleted", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------- helpers ----------

    private fun timeAgo(ts: Long): String {
        val d = System.currentTimeMillis() - ts
        if (d < 60_000) return "abhi-abhi"
        val m = d / 60_000
        if (m < 60) return "$m min pehle"
        val h = m / 60
        if (h < 24) return "$h ghante pehle"
        return "${h / 24} din pehle"
    }
}
