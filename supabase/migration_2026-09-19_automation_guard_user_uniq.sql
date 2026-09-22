-- ============================================================================
-- One-run-per-user guard: user-level partial unique index (2026-09-19)
-- round-7, task (c).
--
-- Maksad: ek time me ek user ki sirf EK active automation. Application-level
-- guard `lib/automation_guard.ts` sab entry points pe laga hai (run-pipeline,
-- run-now, schedule-tick). Lekin check-then-insert race me do concurrent
-- requests (do device, same user, same instant) guard dono pass kar sakti
-- hain. Ye index wo race DB pe band karta hai.
--
-- Fix (DB-level, code-race-proof):
--   Partial unique index (user_id) WHERE status IN ('pending','running')
--   — ek user pe ek hi active pipeline_request, race bhi impossible.
--
-- NOTE (2026-09-19): ye file REPO me ready hai lekin PROD pe abhi APPLY NAHI
-- hui. Apply karne se PEHLE zaroor check karo:
--   1. Kisi user ke do ACTIVE (pending/running) pipeline_requests to nahi —
--      hon to index create fail karega (duplicate key). Pehle purani stuck
--      rows terminal ('done'/'failed') me mark karo.
--   2. `worker/pipeline_watch.py` mark() 'done'/'failed' likhta hai — terminal
--      set match hai, purani index `pipeline_requests_active_device_uniq`
--      (device-level) ke saath koi conflict nahi.
-- Idempotent: dobara chalane pe kuch nahi toot-ta.
-- ============================================================================

create unique index if not exists pipeline_requests_active_user_uniq
  on pipeline_requests (user_id)
  where status in ('pending', 'running');
