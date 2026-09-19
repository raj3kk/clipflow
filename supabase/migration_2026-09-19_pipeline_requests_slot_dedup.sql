-- ============================================================================
-- pipeline_requests slot-level dedup (2026-09-19, round-6 Worker E)
-- Worker B ka gap: "same slot me dobara pipeline_request ban sakti hai".
--
-- Do vector the:
--   1. Concurrent ticks / double-click: check-then-insert race — dono check
--      pass karke dono insert kar dete the.
--   2. Same slot dobara due: request `done`/`failed` ho chuki, lekin slot
--      abhi bhi grace window me hai (times mode: 45 min; interval catchup) —
--      agla tick phir se row bana deta tha, slot do baar chalta tha.
--
-- Fix (DB-level, code-race-proof):
--   a. slot_key column — schedule-tick har due slot-set ke liye deterministic
--      key likhta hai (slots sorted + join).
--   b. Partial unique index (device_id) WHERE pending/running — ek device pe
--      ek hi active request (race bhi ab impossible).
--   c. Unique index (device_id, slot_key) WHERE slot_key IS NOT NULL —
--      same slot ki row dobara kabhi nahi ban sakti, chahe purani row
--      done/failed ho chuki ho. (NULL slot_key wali rows — jaise manual
--      run-pipeline trigger — is index ko touch nahi karti; unke liye (b)
--      kaafi hai.)
--
-- Idempotent: dobara chalane pe kuch nahi toot-ta.
-- ============================================================================

alter table pipeline_requests
  add column if not exists slot_key text;

create unique index if not exists pipeline_requests_active_device_uniq
  on pipeline_requests (device_id)
  where status in ('pending', 'running');

create unique index if not exists pipeline_requests_device_slot_uniq
  on pipeline_requests (device_id, slot_key)
  where slot_key is not null;
