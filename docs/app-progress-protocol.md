# App Progress Protocol (AutoClip ↔ ClipFlow server)

Server-side READY hai — app me abhi koi change nahi hua. Ye doc batata hai
app progress kaise poll kar sakti hai, bina JobEngine logic badle.

## Status (2026-09-19)

- ✅ Server: `GET /api/devices/jobs/[id]` — step progress endpoint LIVE
- ✅ Server: `POST /api/devices/jobs/[id]/heartbeat` — app har step pe bhejti hai (p19)
- ⬜ App: progress polling — implement NAHI hua (optional UX feature)

## Kyun chahiye

Website ka `/devices/live` page server-side data (pipeline_requests + device_jobs)
se "Automation checklist" dikhata hai. App khud apne chal rahe job ka progress
dekhna chahe (Profile tab: "kaam mil gaya" → "upload ho raha hai…") to ye
endpoint use kare — bina naya protocol banaye.

## Endpoint

`GET /api/devices/jobs/:id`

Auth (wahi headers jo `/jobs/next` poll karta hai):
- `X-Device-Id: <device uuid>`
- `X-Device-Key: <device api key>`

Response 200:
```json
{
  "job_id": "uuid",
  "status": "running",
  "type": "automation",
  "current_step": "ig-caption",
  "active_phase": "ig-caption",
  "steps": [
    { "i": 0, "phase": "download", "action": "download", "state": "done" },
    { "i": 1, "phase": "ig-open",  "action": "navigate", "state": "done" },
    { "i": 2, "phase": "ig-caption","action": "eval",    "state": "active" },
    { "i": 3, "phase": "ig-share", "action": "click",    "state": "pending" }
  ],
  "heartbeat": { "count": 12, "last": "2026-09-19T15:30:00Z" },
  "attempts": 1,
  "updated_at": "2026-09-19T15:30:00Z"
}
```

- `state`: `done` | `active` | `pending` — `active` woh phase hai jo
  `current_step` se match karta hai (exact ya prefix match).
- `current_step` kisi phase se match na ho → sab `pending`, `active_phase: "unknown"`.
- Terminal job (`succeeded`) → sab steps `done`.
- 401: device key galat/missing. 404: ye job is device ka nahi.

## App-side integration (minimal change principle)

**Kotlin change abhi mat karo** — server ready hai, app tab integrate kare jab
Profile-tab progress UI banna ho. Sketch:

1. JobEngine jab job start kare, `jobId` ko Worker ke paas rakhe (already hai).
2. Optional: har ~15s me `GET /api/devices/jobs/{jobId}` poll karo —
   SIRF jab job active ho (engine chal raha hai). Terminal status aate hi
   polling band.
3. `steps` se "step X of N" + active phase ka Hinglish label dikhao.
4. Polling JobEngine ke kaam ko affect NAHI karti — heartbeat/result flow
   unchanged rehta hai.

**Cadence guard:** 15s se tez poll mat karo (server + battery). Ye endpoint
cheap hai (1 row read), lekin hot-loop me Doze/battery pe asar padta hai.

## Website checklist se relation

Website checklist (`GET /api/automation/checklist`) server-side stages +
job status se 9 high-level steps banata hai; ye endpoint phone ke raw
step-array ka progress deta hai. Dono ka source of truth same hai
(`device_jobs.current_step` + `payload.steps`).

## Test

```bash
# device headers ke saath (key Secure Vault / device record se)
curl -s -H "X-Device-Id: <id>" -H "X-Device-Key: <key>" \
  https://clipflow-webbuilder1.vercel.app/api/devices/jobs/<job_id> | head -c 600
```

- Galat key → 401 (500 nahi).
- Doosre device ka job id → 404 (leak nahi).
