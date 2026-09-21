# PhoneAgent — Pura System Architecture v1.0
_Delivered: 2026-09-18 | Status: design (build approved nahi hua abhi)_

## 0. Ek line me
Har user ka **Android phone khud uska personal automation server** hai (Honeygain model). Phone background me chalta hai, schedule pe jaagta hai, apne **logged-in** browser session (Whop/Instagram) me kaam karta hai, result central server ko bhejta hai. Server sirf kaam baant-ta aur hisaab rakhta hai — isliye **infra cost ₹0**, aur session tootne ka sawal hi nahi (login user ke apne phone pe hai).

## 1. Goals / Non-goals
**Goals:**
- Bina VPS/server kharche ke per-user browser automation (₹0 infra)
- Session persistence: user ek baar login kare, phir kabhi login na toote
- Scheduled (custom — user jab chahe trigger + custom schedule) + on-demand (push se turant) dono mode — MAX 4 automations per 2 days
- 4 automations per 2 days MAX cap (user-set 2026-09-18), custom schedule + user jab chahe on-demand trigger
- IG action-block auto-pause, har automation ka screenshot proof (tumhara locked standard)
- Agent (Muse/ClipFlow worker) API se kaam de sake, website me integration ho sake

**Non-goals (v1 me nahi):**
- iPhone support (Apple allow nahi karta — Android only)
- Phone pe video render (bhari kaam VM pe hi rahega)
- Ek phone se dusre user ka kaam (har device sirf apne user ka)

## 2. Big picture

```
┌──────────────────────────┐         ┌─────────────────────────────┐
│   USER KA PHONE (Android) │         │  CONTROL PLANE (ClipFlow)    │
│  ┌─────────────────────┐ │  poll   │  ┌───────────────────────┐  │
│  │ Agent App           │ │ ◄────── │  │ Job queue (per device)│  │
│  │ • Login WebView     │ │  HTTPS  │  │ Device registry       │  │
│  │ • Job engine        │ │ ──────► │  │ Dispatcher + FCM wake │  │
│  │ • Scheduler(custom) │ │ results │  │ Dashboard: Devices tab│  │
│  │ • Reporter          │ │         │  └───────────────────────┘  │
│  └─────────────────────┘ │                   │                   │
└──────────────────────────┘                   │ video URL         │
                                               ▼                   │
                          ┌─────────────────────────────────┐     │
                          │ RENDER PIPELINE (VM, existing)  │◄────┘
                          │ clip_factory: mp4 + caption     │
                          │ → Supabase storage              │
                          └─────────────────────────────────┘

Flow: VM clip banata hai → server phone ko job deta hai →
phone apne logged-in IG/Whop me post+submit karta hai → proof wapas.
```

**Key design decision:** phone **poll** karta hai (outbound HTTPS only). Isse koi inbound port, public IP, ya tunnel nahi chahiye — Jio/Airtel CGNAT ke peeche bhi kaam karega. Agent ka "API access" = agent ClipFlow server API pe job banata hai, phone use utha leta hai.

## 3. Components (detail)

### 3.1 Phone Agent App (Kotlin, ~5 modules)
| Module | Kaam |
|---|---|
| `LoginWebView` | User Whop + Instagram login karta hai (ek baar). `CookieManager` cookies persist rakhta hai — app restart/phone reboot ke baad bhi login bana rehta hai |
| `JobEngine` | Job spec (JSON steps) execute karta hai hidden WebView me: navigate, click, type, upload file, JS eval, screenshot, text extract. Selector strategy: pehle `aria-label`/text-match, fallback `evaluateJavascript` |
| `Scheduler` | `WorkManager` PeriodicWorkRequest (custom interval, default 12h, constraint: network connected). Doze me delay ho sakta hai — isliye critical jobs ke liye FCM high-priority push se wake |
| `RunnerService` | Foreground service + persistent notification ("ClipFlow Agent active") taaki Android/OEM (Xiaomi/Oppo/Vivo) app ko kill na kare. `BOOT_COMPLETED` pe schedule dobara lagta hai |
| `Reporter` | Result JSON + screenshots server ko upload, retry ke saath |

**Ek-time user setup (5 min):** APK install → app kholo → enroll code dalo (dashboard se) → Whop login → IG login → battery-optimization "ignore" pe ek tap (guide screen) → done.

### 3.2 Control Plane (ClipFlow me naya hissa)
Nayi tables (Supabase, RLS per-user):
```sql
devices(id uuid pk, user_id uuid, device_name text, platform text default 'android',
        app_version text, fcm_token text, api_key_hash text,
        status text default 'active', last_seen timestamptz, created_at timestamptz default now());
device_jobs(id uuid pk, user_id uuid, device_id uuid, type text, payload jsonb,
        idempotency_key text unique, status text default 'queued',
        attempts int default 0, max_attempts int default 3,
        run_after timestamptz, created_at timestamptz default now());
job_runs(id uuid pk, job_id uuid, device_id uuid, status text, result jsonb,
        screenshots text[], started_at timestamptz, finished_at timestamptz);
```

Naye endpoints:
| Endpoint | Kaun | Kaam |
|---|---|---|
| `POST /api/devices/enroll` | app | enroll code → `device_id` + `api_key` (key ek baar dikhegi) |
| `GET /api/devices/jobs/next` | app (device key) | long-poll 30s → agla job ya 204 |
| `POST /api/devices/jobs/:id/heartbeat` | app | "kaam chal raha hai" |
| `POST /api/devices/jobs/:id/result` | app | result + screenshots |
| `POST /api/devices/:id/wake` | agent/user | FCM push → phone turant jaagta hai |
| `GET /api/devices` | dashboard | devices list, status, aaj ke runs |

### 3.3 Render pipeline (existing, unchanged)
`clip_factory` VM pe: transcribe → 9:16 cut → karaoke captions → mp4 + caption text → Supabase storage. Job payload me sirf `video_url` + `caption` jata hai — phone download karke post karta hai.

### 3.4 Job spec format (example: 1 clip post+submit)
```json
{
  "type": "post_and_submit",
  "idempotency_key": "clip-2026-09-18-03",
  "steps": [
    {"action":"download","url":"https://…/clip3.mp4","as":"clip.mp4"},
    {"action":"navigate","url":"https://www.instagram.com/"},
    {"action":"click","by":"aria","value":"New post","timeout":15000},
    {"action":"upload","by":"css","value":"input[type=file]","file":"clip.mp4"},
    {"action":"click","by":"text","value":"Next"},
    {"action":"type","by":"css","value":"textarea[aria-label*=caption]","text":"Hook line… #BlizzardPartner #DiabloV"},
    {"action":"click","by":"text","value":"Share"},
    {"action":"wait_url","contains":"/reel/","timeout":90000},
    {"action":"screenshot","as":"posted.png"},
    {"action":"extract","js":"location.href","as":"reel_url"},
    {"action":"navigate","url":"https://whop.com/…/submit"},
    {"action":"type","by":"css","value":"input[name=link]","text":"{{reel_url}}"},
    {"action":"click","by":"text","value":"Submit"},
    {"action":"screenshot","as":"submitted.png"}
  ]
}
```
`{{reel_url}}` = pichle step ka extracted value. `idempotency_key` se double-post impossible (server duplicate job banne hi nahi dega).

## 4. Job lifecycle (state machine)
`queued → dispatched → running → (succeeded | failed_retry | failed_dead | blocked)`
- `failed_retry`: attempts < max → `run_after` = +30min, wapas queue
- `blocked`: page pe "try again later / action blocked" text detect → device auto-pause 24h + user ko notification + dashboard alert
- Har transition `job_runs` me log — full audit trail

## 5. Scheduling (Android realities)
- **Normal:** WorkManager custom-interval periodic (default 12h; user dashboard se badal sakta hai). Doze me ±30-60min jitter normal hai — clipping ke liye acceptable
- **Turant:** FCM high-priority data push → app 1-2 min me job utha leti hai
- **Survive reboot:** `BOOT_COMPLETED` receiver schedule dobara lagata hai
- **OEM killers:** Xiaomi/Oppo/Vivo ke liye app me "autostart allow karo" guide screen (ek tap). Battery optimization exemption: `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
- **Phone off tha:** job queue me pada rehta hai, phone on hote hi next window me execute

### 5b. Real-time pickup (p18, 2026-09-19) — FCM ke bina bhi fast
FCM client-side ready hai (google_services.xml bundled, lazy+graceful init),
par server-side push abhi pending hai — isliye polling fallback ko fast banaya:
- **Foreground (app khuli):** MainActivity har **10 sec** `jobs/next` poll karta hai → naya job milte hi TURANT one-time worker + "⚡ Kaam mil gaya" notification. (10s kyun: app khuli = user active + radio on, chhota GET sasta; 1s 24/7 battery+server maar degi.)
- **Background:** RunnerService (foreground service) har **2 min** poll karta hai.
- **Backup:** WorkManager 15-min periodic (platform minimum — isse tez nahi ho sakta).
- Teeno `JobPickup` shared object se guzarte hain: ek gate (enrolled+online+login), 5-min dedupe (duplicate worker nahi), active-job record.
- **Duplicate-worker guard:** do poller ek hi job dekhen to sirf ek worker chalta hai (30-min staleness ke baad ignore; `pickup_job_id` wala worker bypass).
- **Stall safety:** JobEngine me page-load 60s timeout, 20-min job deadline, WebView renderer-crash → fail-mark + server report (app crash nahi).
- **Profile tab:** "Poll: X sec pehle checked" + "Kaam: ⚡ mil gaya (type) — running 3/24" live lines (broadcast se update).

## 6. Security model
- Server **password kabhi nahi dekhta** — login user ke apne phone ke WebView me hota hai
- Enroll: dashboard pe 6-digit code (10 min valid) → app me dalo → per-device `api_key` (phone ke encrypted storage me, server pe sirf hash)
- Job payloads HMAC-signed — phone verify karta hai job asli server se aaya
- Har device sirf apne `user_id` ke jobs dekh sakta hai (RLS) — ek phone dusre ka data chhu nahi sakta
- TLS everywhere. FCM token per device, revoke = device block

## 7. Failure handling matrix
| Fail | Response |
|---|---|
| Phone offline | job queued rehta hai, retry next window |
| Upload timeout | 1 retry, phir `failed_retry` (+30min) |
| IG action block (text detect) | device 24h pause, user notify, baaki devices chalte rahenge |
| WebView crash (renderer gone) | p18: fail-mark + server ko report (app crash nahi); job record me error ke saath |
| Phone ne job aadha kiya aur mar gaya | heartbeat timeout (10 min) → job requeue; idempotency se double-post nahi |
| Galat credentials/session expire | job `failed_dead` + user ko "dobara login karo" notification |

## 8. Verification standard (tumhara locked rule, built-in)
Har automation pe engine automatically: ~1s frame (hook visible?) + caption frames ke screenshots → server pe upload → dashboard pe proof. **Screenshot proof ke bina job `succeeded` mark nahi hoga.** Post→submit 30 min window server enforce karega. **Cap: MAX 4 automations per 2 days** — server 5th job banne hi nahi dega; schedule custom (user jab chahe trigger kar sakta hai).

## 9. Scale & cost
| Item | Cost |
|---|---|
| Phone app | ₹0 (user ka apna phone) |
| Control plane | existing ClipFlow (Vercel free) |
| Render | existing VM (₹0) |
| FCM push | free |
| Screenshot storage | Supabase free 1GB (30-day auto-cleanup) |
| **Total** | **₹0/month. Har naya user apna khud ka "server" leke aata hai — marginal cost zero.** |

## 10. Build phases + acceptance
- **P0 — App shell + enroll + login persistence.** Accept: phone restart ke baad bhi Whop/IG logged-in
- **P1 — Job engine + manual trigger + reporter.** Accept: test account pe pura post+submit dry-run, screenshots ke saath
- **P2 — Scheduler + FCM + server tables/endpoints.** Accept: server pe bana job 15 min ke andar bina haath lagaye execute
- **P3 — Dashboard Devices tab + failure matrix + proofs.** Accept: 6 din tak 4-per-2-days autopilot unattended (12 automations)
- **P4 (optional) — Direct agent API mode:** app me embedded HTTP server + secure tunnel, taaki koi bhi website/agent phone browser ko live drive kar sake (tumhara pehla wala "API browser" idea — isi pe banega)

## 11. Honest limits / risks
1. **Android only.** iOS pe Apple ye allow nahi karta — iPhone users ke liye P4 wala server-browser fallback rahega
2. **WebView ≠ full Chrome.** IG web upload flow WebView me test karna padega real device pe — agar atka to fallback: IG app intent kholo + user ek tap kare (semi-auto). P1 me ye verify hoga, usse pehle "ho jayega" claim nahi
3. **OEM battery killers** — guide screen ke baad bhi kuch phones (ColorOS/MIUI aggressive) me user ko manually "lock" karna pad sakta hai recent-apps me
4. **Schedule jitter** — Doze me exact-time guarantee nahi; "custom interval ± 1h" soch ke chalo
5. **Selectors toot-te hain** — IG/Whop DOM badle to job fail hoga; engine me `eval` fallback + server-side selector update mechanism hai (job spec server se aata hai, app update ki zaroorat nahi)
6. **Rooted phone / fake device** — poori tarah rokna impossible; per-device rate limits (4 per 2 days) + anomaly alerts se mitigate
7. **Pehla real run watched hoga** — unattended claim se pehle ek pura cycle tumhare saamne chalega

## 12. Tumhe kya karna hoga (sirf ye, baaki mera)
1. Build approve karna (ek "haan")
2. Firebase project banana (free, ~5 min, FCM ke liye) — steps main dunga, ya main guide karunga
3. Apne phone pe APK install + ek baar Whop/IG login (5 min)
4. P1 ka watched test-run dekhna

---
*Ye doc `~/workspace/phone-agent/ARCHITECTURE.md` me hai. Build shuru hote hi phases yahin track honge.*

## 13. Two-brain coordination (p39, 2026-09-20)

Phone pe **AgentBrain (Kotlin)** page-level semantic agent hai (perceive → decide → act → rescan, §3.1). Server pe ab **doosra brain** hai — `lib/agent/brain.ts` — jo run-level sochta hai: kaunsa goal, kaunsi skill, phone ko kya directive, aur nateeja goal se mila ya nahi. Dono ek shared memory (`agent_memory`) aur skill registry (`agent_skills`) se judte hain.

```
┌─ SERVER BRAIN (Vercel, lib/agent/brain.ts) ─────────────┐
│ perceive: device state, job queue, campaigns, open       │
│           issues, recent skill_lessons                   │
│ reason:   {goal, chosen_action, rationale, confidence}  │
│ act:      ① skill mastery gate (<0.6 → needs_review)      │
│           ② compliance-guard VETO (hard, never bypassed) │
│           ③ 4/24h cap check                             │
│           ④ enqueue phone job + DIRECTIVE (goal +        │
│              constraints, NOT scripted taps) +           │
│              pipeline_request_id                        │
│ verify:   job bana? goal se mila? (sirf "action ran" nahi)│
│ adapt:    lessons se retry (≤3), phir agent_issue HIGH   │
└──────────────────────────┬──────────────────────────────┘
                           │ job payload.directive
                           ▼
┌─ PHONE BRAIN (Kotlin, AgentBrain v2) ───────────────────┐
│ job start: POST /api/agent/memory/sync pull →            │
│            serverLessons → vars["memory_lessons"]        │
│ run:       directive.goal prefer (community/campaign)    │
│ terminal FAILED → onBrainFailed → POST /api/agent/issues │
│ job end:   episodic outcome push (memory/sync)          │
│ reasoning: heartbeat vars (brain_thought/trail) — Live   │
└──────────────────────────┬──────────────────────────────┘
                           │ episodic outcomes
                           ▼
┌─ TRAINER (worker/agent_trainer.py, cron/manual) ─────────┐
│ job_runs se skill_lessons → agent_memory; mastery_score  │
│ = 0.5·last10 + 0.3·last30 + 0.2·0.5 (transparent rule);  │
│ mastery < 0.6 → needs_review (fail closed)               │
└─────────────────────────────────────────────────────────┘

Escalation: POST /api/agent/issues (device/worker auth) →
Meta cron `clipflow-agent-issues` (15 min) open issues padhke
main-chat assistant ko full context deta hai → root-cause fix.
Payment-looking flow = agent_issue HIGH + needs_user (auto-buy KABHI nahi).
```

**Six skills** (`lib/agent/skills.ts`, versioned, mastery-gated): campaign-scout, compliance-guard (veto), render-director, upload-coordinator (Original 9:16, safe zones), submit-verifier (live-reel frame checks), recovery-specialist.

**Request↔job correlation:** har brain-enqueued job ka payload me `pipeline_request_id` explicit hai — Live page ab time-proximity guess nahi, isi se jodta hai.
