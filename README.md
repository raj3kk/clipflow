# ClipFlow — Whop Clipping Automation

Production dashboard + automation backend for the Whop Content Rewards clipping workflow:

**Campaigns → render queue → preview → approve → Instagram post → Whop submit → tracking**

## Live

- App: `https://clipflow-xxx.vercel.app` (Vercel)
- Repo: `raj3kk/clipflow`

## Setup (one time)

1. **Supabase**: create a NEW project at supabase.com → SQL editor → run `supabase/schema.sql`.
2. **Vercel env vars**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only)
   - `INSTAGRAM_CONNECTED` = `true` once the Meta authorization for `@viralshortz_45` completes (currently stuck at the Accounts Center "already added" step — until then `/api/clips/[id]/post` honestly reports blocked).
3. **Render worker** (on the VM with the edit stack):
   ```bash
   export CLIPFLOW_URL=https://clipflow-xxx.vercel.app
   export SUPABASE_URL=...
   export SUPABASE_SERVICE_KEY=...   # server-side only, never in chat
   export WORKER_SECRET=...          # optional shared secret
   python3 worker/render_worker.py
   ```
   The worker polls `/api/jobs?status=queued`, renders with `clip_factory.py`
   (9:16, hook, karaoke captions, effects), uploads the mp4 + preview frames to
   the `clips` storage bucket, and marks the job `preview`.

## Workflow

1. **Campaigns** page — pick a campaign (rate, budget, requirements).
2. **Clips** page — queue a render job (source URL + start/end seconds + hook).
   Worker renders → preview frames appear → **Approve**.
3. **Post to Instagram** — queued for the automation agent once `INSTAGRAM_CONNECTED=true`.
4. **Submissions** page — record the Whop submission (URL + status) within 20 minutes of posting.

## API (for the worker / agent)

- `GET /api/campaigns` — active campaigns (seed fallback when DB unconfigured)
- `GET/POST /api/clips` — list clips / queue a render job (15–60s enforced)
- `GET /api/jobs?status=queued` — worker job queue
- `PATCH /api/jobs/[id]` — worker updates `{status, video_url, preview_urls, error}`
- `POST /api/clips/[id]/approve` — approve after preview
- `POST /api/clips/[id]/post` — Instagram attempt (honest blocked status until connected)
- `GET/POST /api/submissions` — Whop submission records
- `GET /api/stats` — today's X/4 progress

## Notes

- Without Supabase env vars the UI runs in demo mode with a setup banner — no fake data is ever presented as real.
- Video rendering stays on the VM (free ffmpeg + faster-whisper stack); Vercel only hosts the dashboard + API.
