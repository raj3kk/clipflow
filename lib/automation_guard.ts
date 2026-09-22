import { NextResponse } from "next/server";

/**
 * One-run-per-user guard (2026-09-19, round-7+).
 *
 * User ka maksad: ek time me ek hi automation. Naya automation tabhi start
 * ho jab user ki koi active automation na chal rahi ho.
 *
 * "Active automation" = dono tables me se koi bhi non-terminal row:
 *   - pipeline_requests: status IN ('pending','running')
 *       (terminal: 'done', 'failed' — watcher `done` likhta hai,
 *        TS code me 'succeeded' nahi aata)
 *   - device_jobs: status IN ('queued','claimed','dispatched','running')
 *       (terminal: 'succeeded','failed','timeout','expired','cancelled')
 *
 * Har check user_id-scoped hai — kisi aur user ka job kabhi block nahi karega.
 *
 * Wired entry points (naya automation start karte hain):
 *   1. POST /api/devices/:id/run-pipeline  — Run Now (Devices page +
 *      website AI agent "Abhi Run Karo" → UI yahi fetch karta hai, to
 *      server-side reject yahan lagta hai)
 *   2. POST /api/devices/:id/run-now       — legacy manual trigger
 *   3. POST /api/devices/schedule-tick     — schedule slot fire
 *      (pipeline_requests path + manual-clip direct-job path — dono pe)
 *
 * DELIBERATELY GUARDED NAHI:
 *   - POST /api/devices/:id/plan-job — ye NAYA start nahi, chalti hui
 *     pipeline ka continuation hai (VM planner ne pipeline_requests row pehle
 *     se 'running' kar rakhi hai). Guard lagane se pipeline khud 409 kha ke
 *     marr jayegi — isliye yahan guard nahi hai.
 *   - POST /api/devices/:id/join-campaign — Whop campaign join (phone ka
 *     alag handler); iska apna type-aware live-dedup hai, clip automation
 *     guard se alag rakha gaya hai.
 *
 * Race safety: device-level double-enqueue DB me partial unique indexes se
 * rokta hai (pipeline_requests_active_device_uniq, pipeline_requests_device_slot_uniq).
 * USER-level race (ek user, do device, same instant double-click) application-level
 * guard cover karta hai; same behavior ko DB-hard banane ke liye migration file
 * `supabase/migration_2026-09-19_automation_guard_user_uniq.sql` repo me rakhi
 * hai (partial unique index WHERE pending/running) — abhi apply NAHI hui,
 * apply hote hi user-level race bhi DB pe impossible.
 */

export const ACTIVE_PIPELINE_STATUSES = ["pending", "running"] as const;
export const ACTIVE_JOB_STATUSES = [
  "queued",
  "claimed",
  "dispatched",
  "running",
] as const;

export interface ActiveAutomation {
  /** "pipeline" = pipeline_requests row, "job" = device_jobs row */
  source: "pipeline" | "job";
  id: string;
  status: string;
  /** pipeline_requests.stage (planner phase) ya device_jobs.type */
  detail: string | null;
  device_id: string | null;
  created_at: string | null;
}

/**
 * User ki koi active automation hai to pehli wali (sabse nayi) wapas do,
 * nahi to null. Read-only — guard ke pehle ka "dry check" isi se karo.
 */
export async function findActiveAutomation(
  sb: {
    from: (table: string) => any;
  },
  userId: string
): Promise<ActiveAutomation | null> {
  const { data: pr } = await sb
    .from("pipeline_requests")
    .select("id, status, stage, device_id, created_at")
    .eq("user_id", userId)
    .in("status", [...ACTIVE_PIPELINE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (pr && pr.length > 0) {
    const r = pr[0];
    return {
      source: "pipeline",
      id: r.id,
      status: r.status,
      detail: r.stage ?? null,
      device_id: r.device_id ?? null,
      created_at: r.created_at ?? null,
    };
  }

  const { data: jobs } = await sb
    .from("device_jobs")
    .select("id, status, type, device_id, created_at")
    .eq("user_id", userId)
    .in("status", [...ACTIVE_JOB_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (jobs && jobs.length > 0) {
    const j = jobs[0];
    return {
      source: "job",
      id: j.id,
      status: j.status,
      detail: j.type ?? null,
      device_id: j.device_id ?? null,
      created_at: j.created_at ?? null,
    };
  }
  return null;
}

/**
 * Guard fail hone pe standard 409 Hinglish response.
 * Route handlers: `const conflict = await guardNoActiveAutomation(sb, user.id); if (conflict) return conflict;`
 */
export async function guardNoActiveAutomation(
  sb: { from: (table: string) => any },
  userId: string
): Promise<NextResponse | null> {
  let active: ActiveAutomation | null = null;
  try {
    active = await findActiveAutomation(sb, userId);
  } catch {
    // DB read fail ho to fail-OPEN (automation start karne do) — guard ka
    // fail hona run ko block nahi karega. Monitoring me dikhega.
    return null;
  }
  if (!active) return null;
  return NextResponse.json(
    {
      error:
        "Ek automation pehle se chal rahi hai — uske complete/fail hone ka wait karo.",
      active: {
        source: active.source,
        id: active.id,
        status: active.status,
        detail: active.detail,
        device_id: active.device_id,
        created_at: active.created_at,
      },
    },
    { status: 409 }
  );
}
