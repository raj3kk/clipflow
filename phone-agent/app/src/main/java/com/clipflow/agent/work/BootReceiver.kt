package com.clipflow.agent.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.clipflow.agent.data.DeviceStore
import org.json.JSONObject

/**
 * Phone reboot ke baad RunnerService dobara start karta hai
 * taaki schedule kabhi na toote. RunnerService khud saved
 * custom schedule dobara lagata hai.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // Sleep mode bana rahe: phone jaan-bujh kar offline hai,
            // reboot pe service/schedule dobara mat lagao.
            try {
                if (DeviceStore(context).sleepMode()) return
            } catch (_: Exception) { }
            // saved schedule turant lagao (service start hone se pehle bhi)
            try {
                val store = DeviceStore(context)
                store.getSchedule()?.let {
                    Scheduler.scheduleNext(context, JSONObject(it))
                } ?: Scheduler.schedule(context, 12)
            } catch (_: Exception) {
                try {
                    Scheduler.schedule(context, 12)
                } catch (_: Exception) { }
            }
            context.startForegroundService(Intent(context, RunnerService::class.java))
        }
    }
}
