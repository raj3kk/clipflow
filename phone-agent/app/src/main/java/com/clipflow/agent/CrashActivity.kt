package com.clipflow.agent

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

/**
 * Crash hone par kaaran dikhata hai (blank band hone ke bajaye).
 * User screenshot le kar bhej sakta hai.
 */
class CrashActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(16)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
            setBackgroundColor(Color.WHITE)
        }
        val title = TextView(this).apply {
            text = "AutoClip — kuch gadbad hui"
            textSize = 18f
            setTextColor(Color.RED)
            setPadding(0, 0, 0, dp(8))
        }
        val hint = TextView(this).apply {
            text = "Neeche kaaran likha hai. Iska screenshot le kar bhejo — turant fix hoga."
            textSize = 13f
            setPadding(0, 0, 0, dp(8))
        }
        var trace = intent.getStringExtra("trace")
        if (trace.isNullOrBlank()) {
            trace = try {
                File(filesDir, "last_crash.txt").readText().take(6000)
            } catch (_: Exception) {
                "kaaran padha nahi ja saka"
            }
        }
        val body = TextView(this).apply {
            text = trace
            textSize = 11f
            setTextIsSelectable(true)
            setBackgroundColor(0xFFF5F5F5.toInt())
            setPadding(pad, pad, pad, pad)
        }
        val close = Button(this).apply { text = "Band karo" }
        close.setOnClickListener { finish() }
        layout.addView(title)
        layout.addView(hint)
        layout.addView(body)
        layout.addView(close)
        setContentView(ScrollView(this).apply { addView(layout) })
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
