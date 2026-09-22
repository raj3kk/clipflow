package com.clipflow.agent

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.clipflow.agent.data.DeviceStore
import com.clipflow.agent.net.UpdateChecker
import com.clipflow.agent.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * WP5 (2026-09-20): PERSISTENT update popup — normal aur force DONO updates
 * ke liye same behavior (user ka order).
 *
 *  - Jab tak update install na ho, har app open (MainActivity.onResume) pe
 *    ye screen aati hai. setCancelable nahi (Activity hai), back button
 *    block, aur KOI Cancel / "Baad me" button NAHI.
 *  - States isi flow me: checking → downloading (progress %) → install ready
 *    → permission missing ho to Hinglish Settings guide → wapas install step.
 *    APK corrupt/missing mile to AUTO re-download — flow se bahar nahi.
 *  - Run active ho to install tap pe run KO MAT MAARO: "automation khatm
 *    hote hi install hoga" dikhao, idle hote hi installer AUTO-launch karo.
 *    Dismiss ka option tab bhi nahi.
 *
 * Imaandaar limit: Home button Android OS ka hai — usko koi app rok nahi
 * sakti. User Home dabakar bahar ja sakta hai, lekin app kholte hi yehi
 * screen wapas ayegi jab tak update install nahi hota. System install dialog
 * ka ek "Install" tap bhi Android me hatega nahi.
 */
class UpdateActivity : Activity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var store: DeviceStore

    private var release: UpdateChecker.Release? = null
    private var apkFile: java.io.File? = null
    private var downloading = false
    private var waitingForIdle = false
    private var awaitingPermission = false

    private lateinit var titleTv: TextView
    private lateinit var whyTv: TextView
    private lateinit var statusTv: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var updateBtn: Button

    private val idleHandler = Handler(Looper.getMainLooper())
    private val idlePoll = object : Runnable {
        override fun run() {
            if (!waitingForIdle) return
            if (UpdateChecker.isIdle(this@UpdateActivity)) {
                waitingForIdle = false
                proceedToInstall()
            } else {
                idleHandler.postDelayed(this, 5000)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isShowing = true
        store = DeviceStore(this)
        Notifier.ensureChannel(this)
        buildUi()
        loadRelease()
    }

    override fun onResume() {
        super.onResume()
        // Settings se wapas: permission mil gayi ho to install pe aage badho —
        // user kahin atakna nahi chahiye.
        if (awaitingPermission && UpdateChecker.canInstallPackages(this)) {
            awaitingPermission = false
            statusTv.text = "Permission mil gayi — installer khol rahe hain…"
            proceedToInstall()
            return
        }
        // Run-active wait me the aur ab idle ho: auto-launch installer.
        if (waitingForIdle && UpdateChecker.isIdle(this)) {
            waitingForIdle = false
            idleHandler.removeCallbacks(idlePoll)
            proceedToInstall()
        }
    }

    /** Back dabane se kuch nahi hoga — dismiss ka koi rasta nahi. */
    @Deprecated("WP5: back blocked hai (normal + force dono)")
    override fun onBackPressed() {
        // jaanboojhkar khali — bina update aage nahi
    }

    override fun onDestroy() {
        isShowing = false
        waitingForIdle = false
        idleHandler.removeCallbacks(idlePoll)
        scope.cancel()
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /**
     * Release lao: pehle bg-downloaded pending APK (valid ho to download
     * skip), warna fresh server check. Kuch naya nahi → finish (wapas).
     */
    private fun loadRelease() {
        statusTv.text = "Update ki jaankari load ho rahi hai…"
        scope.launch(Dispatchers.IO) {
            val installedCode = BuildConfig.VERSION_CODE
            val pend = try { store.getPendingUpdate() } catch (_: Exception) { null }
            val pcode = pend?.optInt("code", 0) ?: 0
            if (pcode > 0 && pcode <= installedCode) {
                try { store.clearPendingUpdate() } catch (_: Exception) { }
            }
            val pfile = UpdateChecker.pendingApkFile(this@UpdateActivity)
            if (pcode > installedCode && pfile.exists() && pfile.length() > 100_000) {
                // bg me download ho chuka valid APK — seedha install step
                val rel = UpdateChecker.Release(
                    versionCode = pcode,
                    versionName = pend?.optString("name", "v$pcode") ?: "v$pcode",
                    apkUrl = "",
                    changelog = "",
                    forceUpdate = pend?.optBoolean("force", false) ?: false
                )
                withContext(Dispatchers.Main) { onReleaseReady(rel, pfile) }
                return@launch
            }
            val rel = try { UpdateChecker.checkNow(this@UpdateActivity) } catch (_: Exception) { null }
            withContext(Dispatchers.Main) {
                if (rel == null || !rel.isNewerThanInstalled()) {
                    // naya kuch nahi (race) — wapas normal flow
                    finish()
                    return@withContext
                }
                onReleaseReady(rel, null)
            }
        }
    }

    private fun onReleaseReady(rel: UpdateChecker.Release, file: java.io.File?) {
        release = rel
        apkFile = file
        fillRelease(rel)
        if (file != null) {
            showInstallReady()
        } else {
            // nayi release mili — download auto-start (extra tap nahi)
            startDownload()
        }
    }

    private fun fillRelease(rel: UpdateChecker.Release) {
        if (rel.forceUpdate) {
            titleTv.text = "⬆️\nZaroori update aaya hai"
            titleTv.setTextColor(Color.parseColor("#991B1B"))
            whyTv.text = "Ye update karna LAZMI hai — bina iske purana version " +
                "automation nahi chalayegee. Update me 1-2 minute lagenge — " +
                "aapka data aur login jaise ka waisa rahega."
        } else {
            titleTv.text = "⬆️\nNaya update taiyaar hai"
            titleTv.setTextColor(Color.parseColor("#1E40AF"))
            whyTv.text = "Naya version aa gaya hai. Install me 1-2 minute lagenge — " +
                "aapka data aur login jaise ka waisa rahega."
        }
        val sb = StringBuilder("Naya version: ${rel.versionName}\n")
        if (rel.changelog.isNotBlank()) {
            sb.append("\nIs update me kya naya hai:\n${rel.changelog}")
        }
        statusTv.text = sb.toString().trimEnd()
        statusTv.setTextColor(Color.parseColor("#111827"))
    }

    private fun startDownload() {
        val rel = release ?: return
        if (downloading) return
        downloading = true
        waitingForIdle = false
        idleHandler.removeCallbacks(idlePoll)
        updateBtn.isEnabled = false
        updateBtn.alpha = 0.5f
        updateBtn.text = "Download ho raha hai…"
        progressBar.visibility = android.view.View.VISIBLE
        progressBar.progress = 0
        statusTv.text = "APK download ho rahi hai — app band mat karo."
        updateBtn.setOnClickListener(null)
        scope.launch(Dispatchers.IO) {
            val file = UpdateChecker.downloadRelease(this@UpdateActivity, rel, silent = true) { pct ->
                scope.launch(Dispatchers.Main) {
                    progressBar.progress = pct
                    statusTv.text = "Download ho raha hai… $pct%"
                }
            }
            withContext(Dispatchers.Main) {
                downloading = false
                if (file == null || file.length() < 100_000) {
                    // fail/corrupt — flow se bahar NAHI, dobara try ka rasta
                    try { file?.delete() } catch (_: Exception) { }
                    updateBtn.isEnabled = true
                    updateBtn.alpha = 1f
                    updateBtn.text = "Dobara try karo"
                    updateBtn.setOnClickListener { startDownload() }
                    statusTv.text = "Download fail ho gaya — net check karke \"Dobara try karo\" dabao."
                    return@withContext
                }
                apkFile = file
                try {
                    store.setPendingUpdate(rel.versionCode, rel.versionName, rel.forceUpdate)
                } catch (_: Exception) { }
                showInstallReady()
            }
        }
    }

    private fun showInstallReady() {
        progressBar.visibility = android.view.View.GONE
        updateBtn.isEnabled = true
        updateBtn.alpha = 1f
        updateBtn.text = "Install karo"
        updateBtn.setOnClickListener { proceedToInstall() }
        statusTv.text = "Download poora ho gaya — \"Install karo\" dabao.\n" +
            "Note: Android ka system dialog khulega, wahan \"Install\" dabana hoga."
    }

    /**
     * WP5 run-active safety: run chal raha ho to use KABHI mat maaro.
     * "Automation khatm hote hi install hoga" dikhao; idle hote hi installer
     * AUTO-launch. Dismiss ka option tab bhi nahi.
     */
    private fun proceedToInstall() {
        val file = apkFile?.takeIf { it.exists() && it.length() > 100_000 }
        if (file == null) {
            // corrupt/missing — auto re-download, flow se bahar nahi
            statusTv.text = "File me dikkat mili — dobara download ho rahi hai…"
            startDownload()
            return
        }
        if (!UpdateChecker.isIdle(this)) {
            waitingForIdle = true
            updateBtn.isEnabled = false
            updateBtn.alpha = 0.5f
            updateBtn.text = "Automation khatm hote hi install hoga…"
            statusTv.text = "Automation chal rahi hai — use beech me rokna sahi nahi hoga.\n" +
                "Khatm hote hi installer apne aap khul jayega. Ye popup band nahi hoga."
            statusTv.setTextColor(Color.parseColor("#92400E"))
            idleHandler.removeCallbacks(idlePoll)
            idleHandler.postDelayed(idlePoll, 5000)
            return
        }
        if (!UpdateChecker.canInstallPackages(this)) {
            showPermissionGuide()
            return
        }
        launchInstaller(file)
    }

    private fun launchInstaller(file: java.io.File) {
        val ok = UpdateChecker.installRelease(this, file)
        if (!ok) {
            showPermissionGuide()
            return
        }
        updateBtn.isEnabled = false
        updateBtn.alpha = 0.5f
        updateBtn.text = "Installer khul gaya…"
        statusTv.text = "Installer khul gaya — system dialog me \"Install\" dabao.\n" +
            "Install hote hi app naya version pe chalegi."
        statusTv.setTextColor(Color.parseColor("#065F46"))
        Toast.makeText(this, "Installer khul gaya — Install dabao", Toast.LENGTH_LONG).show()
    }

    /**
     * "Unknown apps" ek baar ka system step — Hinglish guide, non-cancelable.
     * Permission milte hi onResume wapas install step pe le aata hai.
     */
    private fun showPermissionGuide() {
        awaitingPermission = true
        statusTv.text = "Install ke liye ek baar ki permission chahiye — neeche \"Settings kholo\" dabao."
        AlertDialog.Builder(this)
            .setTitle("Ek permission chahiye")
            .setMessage(
                "App update install karne ke liye Android ko ek baar permission deni hogi:\n\n" +
                    "Settings khulegi → \"Unknown apps\" ya \"Install unknown apps\" " +
                    "me AutoClip ke liye Allow karo. Ye sirf EK BAAR ka step hai — " +
                    "uske baad wapas aate hi installer khul jayega."
            )
            .setPositiveButton("Settings kholo") { _, _ ->
                UpdateChecker.openUnknownAppSourcesSettings(this)
            }
            .setCancelable(false)
            .show()
    }

    private fun buildUi() {
        val root = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#EFF6FF"))
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(24))
        }

        titleTv = TextView(this).apply {
            text = "⬆️\nUpdate"
            textSize = 26f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1E40AF"))
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(8))
        }
        whyTv = TextView(this).apply {
            textSize = 16f
            setTextColor(Color.parseColor("#1E3A8A"))
            setLineSpacing(dp(4).toFloat(), 1f)
            setPadding(0, 0, 0, dp(12))
        }
        statusTv = TextView(this).apply {
            text = "Update ki jaankari load ho rahi hai…"
            textSize = 15f
            setTextColor(Color.parseColor("#6B7280"))
            setPadding(0, 0, 0, dp(8))
        }
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = android.view.View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(12)
            ).apply { setMargins(0, dp(8), 0, dp(8)) }
        }
        updateBtn = Button(this).apply {
            text = "Ruko…"
            textSize = 18f
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(14).toFloat()
                setColor(Color.parseColor("#2563EB"))
            }
            minHeight = dp(64)
            isEnabled = false
            alpha = 0.5f
        }
        val note = TextView(this).apply {
            text = "Note: install ke waqt Android ek system dialog dikhayega — wahan \"Install\" dabana hoga. " +
                "Ye Android ka rule hai, koi app ise hata nahi sakti."
            textSize = 13f
            setTextColor(Color.parseColor("#9CA3AF"))
            setPadding(0, dp(16), 0, 0)
            setLineSpacing(dp(3).toFloat(), 1f)
        }

        box.addView(titleTv)
        box.addView(whyTv)
        box.addView(statusTv)
        box.addView(progressBar)
        box.addView(updateBtn)
        box.addView(note)
        root.addView(box)
        setContentView(root)
    }

    companion object {
        /** MainActivity.onResume dobara launch na kare isliye. */
        var isShowing: Boolean = false

        fun intent(ctx: android.content.Context): Intent =
            Intent(ctx, UpdateActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
    }
}
