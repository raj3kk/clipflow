import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { reconcileStaleJobs } from "@/lib/device_jobs";

/**
 * Phone ka long-poll: "mere liye koi kaam hai?"
 *
 * GET /api/devices/jobs/next  (X-Device-Id + X-Device-Key headers)
 *   → 204 (koi job nahi) ya { has_job, job_id, type, payload }
 *
 * Job milte hi atomic claim hota hai (UPDATE ... WHERE status='queued'):
 * concurrent poll me sirf ek claimer jeet-ta hai.
 * Har poll pe heartbeat-timeout reconciliation bhi chalti hai (45 min) —
 * shared reconcileStaleJobs (lib/device_jobs.ts). Phone app khud heartbeat
 * NAHI bhejta (sirf claim-time); isliye cutoff 45 min hai taaki 10-20 min ki
 * lambi automation beech me wapas queue na ho jaye. Schedule-tick (har 15 min)
 * bhi yahi reconcile chalata hai — phone marr jaye to bhi recovery hoti hai.
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
  });
}
