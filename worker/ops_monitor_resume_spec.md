# Resume-from-checkpoint — server ↔ app contract

**Status (2026-09-19): SERVER-READY, APP PENDING.** Server side poora tayyar
hai (`ops_monitor.py` requeue pe payload me checkpoint likhta hai); phone app
(AutoClip) abhi `resume_from_step` padhta NAHI — `JobEngine.run()` hamesha
step 0 se chalata hai. App change agle APK me aana hai; tab tak requeued job
shuru se chalega (koi nuksan nahi — bas checkpoint unused rahega).

## Server kya likhta hai (requeue pe)

`device_jobs.payload` (JSONB, read-modify-write merge — baaki keys untouched):

| Key | Type | Matlab |
|---|---|---|
| `resume_from_step` | int \| null | 0-based step index jahan se app shuru kare. `null` = parse nahi hua → step 0 (safe default). `== len(steps)` = saare steps ✓ the, koi step mat chalao, sirf result report karo. |
| `resume_from_label` | string | Asli `current_step` label, e.g. `"step 3/10 (upload) ✓"` (debug ke liye). |
| `resume_note` | string | Wajah, e.g. `"label '…' → step 3 se resume (✓ wala chhoda)"`. |

`device_jobs.current_step` **preserve** rehta hai — PATCH use chhoota hi nahi.
Live page pe "kaam kahan atka tha" dikhta rehta hai.

### Index kaise nikalta hai (ops_monitor.parse_resume_index)

App heartbeat label format: `"step {N}/{T} ({action})"` step shuru pe,
khatm pe `" ✓"` / `" ✗: wajah"` judta hai.

- `"step 3/10 (upload) ✓"` → `3` (step 3 poora ho chuka, 4th = index 3 se aage)
- `"step 3/10 (upload)"` ya `"step 3/10 (upload) ✗: …"` → `2` (step 3 ka
  poora hone ka saboot nahi — dobara chalao)
- label parse na ho / khaali → `null` (step 0)
- `idx >= len(steps)` → `len(steps)` (report-only)

`len(steps)` payload ke `steps` array se liya jata hai (label ke T se zyada
bharosa payload pe).

## App ko kya karna hai (agle APK me)

`JobEngine.run(job)` me — chhota change:

```kotlin
val steps = job.getJSONArray("steps")
val total = steps.length()
// SERVER RESUME: ops_monitor requeue pe checkpoint likhta hai
val startIdx = job.optInt("resume_from_step", 0).coerceIn(0, total)
for (i in startIdx until total) { ... }  // pehle: for (i in 0 until total)
```

`startIdx == total` → loop zero baar chalega → seedha result report (sahi:
kaam poora tha, sirf report miss hui thi).

### ⚠️ Vars caveat (zaroori)

`{{var}}` placeholders (`reel_url`, `t_upload_ms`, `t_submit_ms`) **in-memory**
`vars` map se bharte hain. Beech se resume karne pe pichhle `extract` steps
dobara NAHI chalenge → vars khaali → baad wale steps fail honge (jabki
shuru-se-restart me extract dobara chalkar vars bhar deta).

Recommended fix (app side, resume ke saath hi ship karo):

1. Har step ke end pe (`onStepEnd`) `vars` map ko
   `workDir/job_<id>_vars.json` me persist karo.
2. Resume pe (`resume_from_step > 0`): vars file load karo; **file na mile to
   `startIdx = 0` pe gir jao** (safe restart — checkpoint se zyada zaroori
   sahi result hai).
3. Report ke baad vars file delete karo (purana state agle job me leak na ho).

### Step idempotency note

Resume **adhura step dobara** chalata hai (koi ✓ nahi mila). Isliye:

- `download`/`navigate`/`extract`/`screenshot` — idempotent, dobara safe.
- IG "post" jaisa step adhura atka ho to dobara chalane pe **duplicate post**
  ka khatra hai. Server is case me resume index wahi step dega (✓ nahi tha).
  Lambi-avadhi fix: post se pehle `extract` se "kya ye video pehle post ho
  chuka?" check (idempotency guard) — workflow design ka kaam, is worker ka nahi.
- `join_campaign` jobs me steps array nahi hota (`runJoinCampaign` alag path)
  — unpe `resume_from_step` ignore hota hai (hamesha fresh join flow).

## Claim flow pe asar

`POST /api/devices/jobs/next` claim pe `payload` poora ka poora phone ko
milta hai (resume keys samet) — koi API change NAHI chahiye. Claim pe
`attempts+1` hota hai (isliye watchdog attempts increment NAHI karta —
double-count se bachne ke liye).
