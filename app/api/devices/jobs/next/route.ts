import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { reconcileStaleJobs } from "@/lib/device_jobs";
import { getLatestRelease } from "@/lib/app_release";

/**
 * Phone ka long-poll: "mere liye koi kaam hai?"
 *
 * GET /api/devices/jobs/next  (X-Device-Id + X-Device-Key headers)
 *   → 204 (koi job nahi) ya { has_job, job_id, type, payload }
 *
 * Job milte hi atomic claim hota hai (UPDATE ... WHERE status='queued'):
 * concurrent poll me sirf ek claimer jeet-ta hai.
 * Har poll pe heartbeat-timeout reconciliation bhi chalti hai (45 min) —
 * shared reconcileStaleJobs (lib/device_jobs.ts). Schedule-tick (har 15 min)
 * bhi yahi reconcile chalata hai — phone marr jaye to bhi recovery hoti hai.
 *
 * HELD-JOB RETURN (P0 fix 2026-09-19): phone job claim karke (dispatched)
 * use chalane se PEHLE jobs/next dobara poll karta hai (AutomationWorker).
 * Pehle ye route sirf 'queued' jobs deta tha — isliye worker ko 204 milta
 * tha, wo silent success leke nikal jata tha, aur app "queue me hai, shuru
 * hone wala hai" pe hamesha atki rehti thi (heartbeat_count=0,
 * current_step=null) — automation KABHI complete nahi hoti thi. Ab device
 * ki wo dispatched/running job jiska terminal report nahi aaya, use hold
 * karke wapas diya jata hai taaki worker use utha ke chala sake.
 */
export async function GET(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  await touchDevice(ident.deviceId, req.headers.get("x-app-version"));

  // 1) Heartbeat-timeout reconciliation (shared — schedule-tick bhi chalata hai).
  await reconcileStaleJobs(sb, ident.deviceId, ident.userId);

  // 1b) HELD-JOB RETURN (P0 fix 2026-09-19) — kyun:
  //     JobPickup.pollAndStart → nextJob() → claim (dispatched) → phir
  //     AutomationWorker dobara nextJob() poll karta hai. Agar yahan sirf
  //     'queued' jobs milen to worker ko 204 milta hai aur wo BINA active-job
  //     saaf kiye silent success leke nikal jata hai — app "queue me hai" pe
  //     atki rehti hai, automation kabhi chalti hi nahi.
  //     Isliye: device ki dispatched/running job (jiska terminal report nahi
  //     aaya — result route terminal pe device_jobs.status badal deta hai)
  //     use hold karke wapas do.
  //     - attempts dobara NAHI badhate (ye wahi logical attempt hai).
  //     - job_runs me nayi row NAHI (claim wali 'dispatched' row pehle se hai).
  //     - last_heartbeat ko HAATH NAHI lagate — reconcile ka stale-backstop
  //       (10/45 min) bana rehna chahiye; poison job infinite nahi ghumegi.
  //     - Fresh heartbeat (3 min, hb>0) = koi worker ZINDA hai → 204, taaki
  //       do worker ek hi job na chalaye (duplicate IG post ka khatra).
  const HOLD_FRESH_MS = 3 * 60 * 1000;
  const nowIso = new Date().toISOString();
  const { data: held } = await sb
    .from("device_jobs")
    .select("id, type, payload, heartbeat_count, last_heartbeat, created_at")
    .eq("device_id", ident.deviceId)
    .in("status", ["dispatched", "running"])
    // run_after future me hai to abhi wapas mat do (hold ka samman —
    // jaise queued path karta hai). NULL run_after = turant eligible.
    .or(`run_after.is.null,run_after.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (held) {
    const hbCount = held.heartbeat_count ?? 0;
    const baseIso = held.last_heartbeat ?? held.created_at;
    const baseMs = baseIso ? new Date(baseIso).getTime() : NaN;
    const workerAlive =
      hbCount > 0 &&
      Number.isFinite(baseMs) &&
      Date.now() - baseMs < HOLD_FRESH_MS;
    if (workerAlive) {
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json({
      has_job: true,
      job_id: held.id,
      type: held.type,
      payload: (held as { payload?: Record<string, unknown> }).payload ?? {},
      held: true,
      // WP4 piggyback: phone ko alag /api/app/version call nahi karni padegi.
      app_update: await getLatestRelease(sb),
    });
  }

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, type, payload, attempts, max_attempts")
    .eq("device_id", ident.deviceId)
    .eq("status", "queued")
    .lte("run_after", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!job) {
    return new NextResponse(null, { status: 204 });
  }

  // 2) Atomic claim: UPDATE ... WHERE status='queued' ek hi statement me.
  //    Concurrent poll me sirf ek claimer jeet-ta hai; baaki ko 204.
  const now = new Date().toISOString();
  const { data: claimed } = await sb
    .from("device_jobs")
    .update({
      status: "dispatched",
      attempts: (job.attempts ?? 0) + 1,
      last_heartbeat: now,
    })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id, type, payload");

  if (!claimed || claimed.length === 0) {
    return new NextResponse(null, { status: 204 });
  }
  const c = claimed[0];

  await sb.from("job_runs").insert({
    job_id: c.id,
    device_id: ident.deviceId,
    user_id: ident.userId,
    status: "dispatched",
    started_at: now,
  });

  return NextResponse.json({
    has_job: true,
    job_id: c.id,
    type: c.type,
    payload: (c as { payload?: Record<string, unknown> }).payload ?? {},
    // WP4 piggyback: phone ko alag /api/app/version call nahi karni padegi.
    app_update: await getLatestRelease(sb),
  });
}
