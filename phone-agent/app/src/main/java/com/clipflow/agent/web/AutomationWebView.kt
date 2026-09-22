package com.clipflow.agent.web

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.webkit.WebView
import com.clipflow.agent.engine.ManualDemo

/**
 * Automation WebView — user ke taps ManualDemo (tap-learning) ko milte hain.
 *
 * Jab user khud app me tap karke koi step karta hai (jaise campaign join
 * ka button), ManualDemo wo tap signature seekh leta hai taaki agli baar
 * automation usi element ko khud dhoondh sake. Sirf tab active jab
 * DeviceStore.learnFromUser() true ho aur koi learning run chal rahi ho —
 * warna ye sirf pass-through hai.
 */
class AutomationWebView : WebView {

    constructor(context: Context) : super(context)

    constructor(context: Context, attrs: AttributeSet?) : super(context, attrs)

    constructor(context: Context, attrs: AttributeSet?, defStyleAttr: Int)
        : super(context, attrs, defStyleAttr)

    override fun onTouchEvent(event: MotionEvent): Boolean {
        try {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> ManualDemo.onTouchDown(event.x, event.y)
                MotionEvent.ACTION_UP -> ManualDemo.onTouchUp(event.x, event.y)
                MotionEvent.ACTION_CANCEL -> ManualDemo.onTouchCancel()
            }
        } catch (_: Exception) {
            // tap-learning kabhi touch handling nahi todega
        }
        return super.onTouchEvent(event)
    }
}
