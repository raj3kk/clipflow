# ClipFlow pipeline worker

Full SOP pipeline per approved clip: **schedule → brief check → post →
verify → submit**, with an activity-log entry at every step
(`POST /api/activity {actor:'worker', event, detail}`).

`render_worker.py` (the original queued→preview renderer) is **untouched**.
This pipeline worker owns the *approved* lifecycle; it can also render
queued jobs with `--render`, but that is off by default to avoid
double-claiming with `render_worker.py`.

## Files

| File | Purpose |
|---|---|
| `pipeline_worker.py` | main pipeline + `--once` / daemon loop / `--plan` |
| `config.py` | env, no_proxy fix, AES-256-GCM decrypt, Supabase REST + storage helpers, activity log |
| `cdp.py` | minimal CDP client (tabs, cookies, navigate, JS eval, screenshots) |
| `gmail.py` | IMAP read + SMTP send (app_password or XOAUTH2); `send_notification`, `find_reply` |
| `interventions.py` | `InterventionNeeded` → API record → Gmail email → wait for reply → consume value transiently (never logged); 30-min timeout |
| `run_once.sh` | cron entrypoint: venv python `pipeline_worker.py --once`, logs to `logs/` |
| `render_worker.py` | legacy renderer — do not modify |

## Env vars

| Var | Required | Purpose |
|---|---|---|
| `CLIPFLOW_URL` | yes | e.g. `https://clipflow-xxx.vercel.app` |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | yes | service_role key (server-side only, never in repo) |
| `WORKER_SECRET` | recommended | sent as `x-worker-secret` header |
| `CONNECTIONS_ENCRYPT_KEY` | for connections | 64 hex chars (32 bytes); decrypts instagram/whop/gmail secrets |
| `CLIPFLOW_LIVE` | no | `1` = real publish/submit clicks. **Default `0` = DRY-RUN** |
| `POLL_SECONDS` | no | daemon poll interval (default 60) |
| `GMAIL_POLL_SECONDS` | no | intervention reply poll interval (default 120) |

## Encryption scheme (connection secrets)

- Algorithm: **AES-256-GCM**, key = 32 bytes from hex in `CONNECTIONS_ENCRYPT_KEY`.
- Ciphertext format: `base64(JSON({"iv": b64, "tag": b64, "data": b64}))` —
  mirrors the documented Next.js `lib/crypto` envelope (implement that side
  with the same layout; `config.encrypt_connection_secret()` produces it).
- Secrets are decrypted **in memory only**, used transiently, and **never
  logged, never written to disk, never stored in memory files**. The key
  itself lives only in the environment — never in this repo.
- Tampered payloads / wrong key → `ValueError`, job fails loudly.

## Running

```bash
# single pass (cron)
/home/hatch/workspace/clipflow/worker/run_once.sh

# daemon
/home/hatch/workspace/whop-edit-env/bin/python pipeline_worker.py

# print the dry-run plan for a sample job (no side effects)
/home/hatch/workspace/whop-edit-env/bin/python pipeline_worker.py --plan
```

Cron line (owner creates it — the worker never does):

```
*/5 * * * * /home/hatch/workspace/clipflow/worker/run_once.sh
```

## Pipeline detail

1. **render** (`--render` only): yt-dlp section → `clip_factory` →
   QA (`ffprobe` = exactly 1080×1920, duration within campaign min/max,
   preview frames at 1s/33%/66%/90% non-blank via PIL) → upload mp4 +
   frames → job `preview`.
2. **schedule**: proceeds only if `now >= scheduled_for`, today's posted
   count (IST midnight boundary) `< daily_target` (default 4), and last
   post `>= spacing_hours` (default 4) ago — re-checked via `/api/posts`.
   Otherwise logs `schedule_skip` and leaves the job scheduled.
3. **brief_check**: campaign requirements / caption_template / hashtags from
   `/api/campaigns`; verifies caption contains required tags, duration in
   min/max, hook present; writes `brief_check` JSON to the job; fails → job
   `failed` + activity entry.
4. **post**: `Poster` interface. `api_poster` = `instagram-cli post-feed
   --account-id … --file … --cover … --caption …` (only when the binary and
   an `api`-kind instagram connection exist). `web_poster` = CDP:
   session-cookies login (`Network.setCookie`, works for httponly) or
   username/password form login; 2FA → `InterventionNeeded('otp')`.
   **Action block** ("try again later" / "action blocked" / "we restrict")
   → whole pipeline STOPS, `action_block` activity, notify email,
   settings paused, `sys.exit(0)` — never auto-retries.
   DRY-RUN: everything except the final publish click; logs exactly what
   would happen.
5. **verify** (mandatory before submit): CDP opens the LIVE reel URL, seeks
   video to 1s/33%/66%/90% via `Runtime.evaluate`, screenshots each;
   checks video actually plays (`currentTime` advances), no error text
   ("having trouble playing", "couldn't load"); PIL-compares live frames
   vs local preview frames (downscaled 135×240, mean abs diff; threshold
   30) → too different ⇒ `verify_status: needs_review` +
   `InterventionNeeded('user_choice')` (owner APPROVE/REJECT by reply).
   Frames uploaded to storage; `PATCH /api/posts/[id]
   {verify_status, verify_detail}`.
6. **submit**: Whop via CDP with the whop `google_oauth` cookies; fill
   campaign, paste `instagram_url`, submit; "Clip submitted" →
   `POST /api/submissions {clip_id, instagram_url, post_id,
   keep_live_until = today+30d}`. Waitlist → activity + info intervention
   (not a failure). Warns in activity if >20 min elapsed since `posted_at`
   (SOP target: submit within 30 min).

Interventions (OTP, user choice, any human input): record via
`POST /api/interventions`, email `ClipFlow input needed: …` from the gmail
connection to `settings.notify_email`, then poll Gmail IMAP for a matching
reply **and** `GET /api/interventions?status=resolved`; consume the value
via `/api/interventions/[id]/consume`, use it transiently, never log it.
30-minute timeout → expired → job fails gracefully.

## Deliberately stubbed / not yet live-verified

- **Web poster composer flow**: cookie + credential login are implemented;
  the IG web *composer* (file picker → Original aspect → Share click) is a
  best-effort skeleton — IG's DOM changes often and the Share click has not
  been verified on a live build. DRY-RUN logs the intended steps.
- **Whop submit form**: login via cookies + navigation + best-effort
  field/button selectors; campaign-specific DOM not yet verified live.
- **Verify frame diff** is heuristic (threshold 30): it flags gross
  crop/zoom, not subtle caption clipping — the owner-choice intervention is
  the backstop, per the locked SOP.
- **API surface assumed** (must exist on the Next.js side): `/api/jobs`,
  `/api/posts`, `/api/submissions`, `/api/activity`, `/api/settings`,
  `/api/campaigns`, `/api/connections/{instagram,whop,gmail}`,
  `/api/interventions` (+ `/[id]/consume`). Field names are defensive
  (`.get()` with SOP defaults) but the app must serve these routes.

## Honest limits

- **Unattended IG web posting vs reCAPTCHA/login-risk**: headless posting to
  instagram.com can trigger login challenges or action blocks; Meta's
  official API path (`api_poster` via `instagram-cli`, once Meta app auth is
  unblocked) is the preferred, safer backend. Until then, web posting stays
  DRY-RUN.
- **Dry-run is the default.** Nothing in this worker performs a real IG
  publish or Whop submit unless `CLIPFLOW_LIVE=1` is explicitly set in the
  environment — never in code.
- **2FA/OTP and verify disputes need the owner**: the worker emails and
  waits up to 30 min; phone-SMS codes are asked, never auto-read.
- **Action blocks are terminal for the run**: the worker stops and stays
  stopped until the owner unpauses in the dashboard.

## What the owner still needs to do

1. Create the **new Supabase project** and run `supabase/schema.sql`
   (tables: jobs/clips, posts, submissions, activity_log, settings,
   campaigns, connections, interventions + `clips` storage bucket).
2. Set **Vercel env vars**: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   (+ `WORKER_SECRET`, `CONNECTIONS_ENCRYPT_KEY` for the worker/API).
3. Fill **connections in the ClipFlow UI**: instagram (api or web/cookies),
   whop (google_oauth cookies), gmail (app_password or oauth).
4. Implement the **assumed API routes** listed above (incl. Next.js
   `lib/crypto` with the AES-256-GCM envelope documented here).
5. Set `CLIPFLOW_LIVE=1` only after a successful dry-run + owner review.
6. Create the **5-minute cron** (`crontab -e`): the line above.
