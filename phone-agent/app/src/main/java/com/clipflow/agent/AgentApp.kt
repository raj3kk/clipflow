package com.clipflow.agent

import android.app.Application
import android.content.Intent
import android.util.Log
import java.io.File
import java.util.Date

/**
 * Global crash catcher: agar app kahin bhi crash ho, to band hone ke bajaye
 * CrashActivity khul kar SAHI KAARAN dikhayega (screenshot le kar bheja ja sakta hai).
 * Trace filesDir/last_crash.txt me bhi save hota hai.
 */
class AgentApp : Application() {

    override fun onCreate() {
        super.onCreate()
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            try {
                val trace = Log.getStackTraceString(err)
                try {
                    File(filesDir, "last_crash.txt").writeText(
                        "${Date()}\nThread: ${thread.name}\n$trace"
                    )
                } catch (_: Exception) { }
                val i = Intent(this, CrashActivity::class.java).apply {
                    addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TASK
                    )
                    putExtra("trace", trace.take(6000))
                }
                startActivity(i)
            } catch (_: Exception) { }
            // default handler ko bhi chalao taaki system crash report bane
            try {
                prev?.uncaughtException(thread, err)
            } catch (_: Exception) { }
        }
        // Firebase LAZY init (p9): provider auto-init hataya gaya hai taaki
        // launch kabhi na atke. Yahan crash handler lagne KE BAAD init hota
        // hai, aur Throwable bhi pakda jata hai — Firebase toote to bhi app
        // khulni chahiye; FCM ke bina 15-min polling backup chalta rahega.
        try {
            com.google.firebase.FirebaseApp.initializeApp(this)
        } catch (_: Throwable) {
            Log.w("AgentApp", "Firebase init failed — polling fallback rahega")
        }
    }
}
