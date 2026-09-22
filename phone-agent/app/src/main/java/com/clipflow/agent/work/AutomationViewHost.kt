package com.clipflow.agent.work

import android.webkit.WebView

/**
 * Live automation WebView ka shared handle.
 *
 * AutomationWorker apna WebView yahan publish karta hai taaki:
 *  - JobEngine live-frame capture kar sake (runLiveSession)
 *  - ManualDemo tap-learning isi view pe chale
 *  - Profile/Live tab ko current page ka pata chale
 *
 * Sirf ek writer (AutomationWorker), @Volatile se safe publish.
 */
object AutomationViewHost {

    @Volatile
    var liveView: WebView? = null
}
