# ClipFlow v2 worker — phone automation pipeline

Zero-touch pipeline: **Run Now / schedule → pipeline_watch → planner_v2
(campaign → download → render → phone job) → phone app (IG post + Whop submit)**.

The old v1 server-side posting engine (`pipeline_worker.py`,
`interventions.py`, `render_worker.py`) was removed in Round-4. Do not
recreate it — the phone app is the only poster.

## Files

| File | Purpose |
|---|---|
| `planner_v2.py` | campaign pick → yt-dlp section download → clip_factory 9:16 render → clip package → device_jobs enqueue |
| `pipeline_watch.py` | watches `pipeline_requests` (Run Now triggers) → runs planner → tracks stages |
| `brain.py` | shared helpers |
| `ytgrab.py` | YouTube section grab (android→ios→web clients, multi-round retry; `--no-check-certificate`, `--js-runtimes node`) |
| `config.py` | env, no_proxy fix, Supabase REST helpers, activity log |
| `gmail.py` | IMAP read + SMTP send (notifications only) |
| `cdp.py` | legacy CDP client (unused by v2 phone flow) |
| `run_planner.sh` | cron entrypoint (every 6h): venv python `planner_v2.py --once`, logs to `logs/planner_v2.log` |
| `run_pipeline_watch.sh` | cron entrypoint (every 1 min): `pipeline_watch.py`, logs to `logs/pipeline_watch.log` |
| `run_once.sh` | legacy v1 entrypoint — orphaned (its `pipeline_worker.py` is deleted) |

## Env

Worker env lives in `~/.config/clipflow/worker.env` (mode 600), loaded by the
`run_*.sh` wrappers. Never commit secrets to the repo.

## Guards

- Max 4 automation runs per rolling 24h (cap enforced server-side; 429 when full).
- IG action-block → pause device + notify, no auto-retry.
- Screenshots at every phone step (proof), post→submit ≤ 30 min.
