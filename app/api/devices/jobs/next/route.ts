import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone ka long-poll: "mere liye koi kaam hai?"
 *
 * GET /api/devices/jobs/next  (X-Device-Id + X-Device-Key headers)
 *   → 204 (koi job nahi) ya { has_job, job_id, type, payload }
 *
 * Job milte hi atomic claim hota hai (UPDATE ... WHERE status='queued'):
 * concurrent poll me sirf ek claimer jeet-ta hai.
 * Har poll pe heartbeat-timeout reconciliation bhi chalti hai (15 min).
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

  // 1) Heartbeat-timeout reconciliation: 15 min se zyada purane
  //    dispatched/running jobs wapas queue (attempts bache hon to),
  //    warna terminal "timeout" (dashboard me human review ke liye).
  const STALE_MS = 15 * 60 * 1000;
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data: stale } = await sb
    .from("device_jobs")
    .select("id, attempts, max_attempts")
    .eq("device_id", ident.deviceId)
    .in("status", ["dispatched", "running"])
    .lt("last_heartbeat", staleCutoff);
  for (const s of stale ?? []) {
    const now2 = new Date().toISOString();
    if ((s.attempts ?? 0) < (s.max_attempts ?? 3)) {
      await sb
        .from("device_jobs")
        .update({ status: "queued", run_after: new Date(Date.now() + 60 * 1000).toISOString() })
        .eq("id", s.id);
      await sb.from("job_runs").insert({
        job_id: s.id,
        device_id: ident.deviceId,
        user_id: ident.userId,
        status: "timeout_requeued",
        result: { error: "heartbeat timeout — wapas queue" },
        finished_at: now2,
      });
    } else {
      await sb.from("device_jobs").update({ status: "timeout" }).eq("id", s.id);
      await sb.from("job_runs").insert({
        job_id: s.id,
        device_id: ident.deviceId,
        user_id: ident.userId,
        status: "timeout",
        result: { error: "heartbeat timeout — attempts khatam, human review" },
        finished_at: now2,
      });
    }
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
  });
}
