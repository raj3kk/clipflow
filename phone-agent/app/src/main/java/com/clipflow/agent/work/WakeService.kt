package com.clipflow.agent.work

import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Server se FCM push ("abhi kaam hai") → turant one-time automation run.
 *
 * NOTE: iske liye Firebase project ka google-services.json chahiye
 * (owner ka ~5 min ka kaam). Jab tak nahi hai, ye class compile to hogi
 * lekin push nahi aayenge — phone apne WorkManager schedule pe chalta rahega.
 */
class WakeService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        if (msg.data["wake"] == "1") {
            try {
                // WorkManager ka auto-init manifest se hata hai; pehle ensure karo.
                com.clipflow.agent.work.Scheduler.ensureInitialized(this)
                val req = OneTimeWorkRequestBuilder<AutomationWorker>()
                    .addTag(AutomationWorker.TAG_AUTOMATION)
                    .build()
                WorkManager.getInstance(this).enqueue(req)
            } catch (_: Exception) {
                // silent — agla 15-min poll backup hai
            }
            // WP4 (2026-09-20): FCM wake = update check event. Enqueue ko
            // block nahi karta — check bg me, 15-min min-gap ke saath.
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val rel = com.clipflow.agent.net.UpdateChecker.checkForEvent(this@WakeService)
                        ?: return@launch
                    com.clipflow.agent.net.UpdateChecker.handleReleaseAsync(this@WakeService, rel)
                } catch (_: Exception) { }
            }
        }
    }

    /**
     * Naya FCM token → server pe register karo taaki "Run Now"
     * push bhej sake. Failure silent hai (schedule/poll backup hai).
     * Actual POST PresenceClient me hai — app launch pe token miss
     * ho jaye to MainActivity bhi wahin se register karta hai.
     */
    override fun onNewToken(token: String) {
        CoroutineScope(Dispatchers.IO).launch {
            com.clipflow.agent.net.PresenceClient.registerFcmToken(this@WakeService, token)
        }
    }
}
