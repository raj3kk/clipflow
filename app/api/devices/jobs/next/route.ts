import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone ka long-poll: "mere liye koi kaam hai?"
 *
 * GET /api/devices/jobs/next  (X-Device-Id + X-Device-Key headers)
 *   → 204 (koi job nahi) ya { has_job, job_id, type, payload }
 *
 * Job milte hi status dispatched + attempts++ (idempotent nahi — ek job
 * ek hi device ko milta hai; heartbeat timeout pe wapas queue hota hai).
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

  await touchDevice(ident.deviceId);

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

  const now = new Date().toISOString();
  await sb
    .from("device_jobs")
    .update({
      status: "dispatched",
      attempts: (job.attempts ?? 0) + 1,
      last_heartbeat: now,
    })
    .eq("id", job.id);

  await sb.from("job_runs").insert({
    job_id: job.id,
    device_id: ident.deviceId,
    user_id: ident.userId,
    status: "dispatched",
    started_at: now,
  });

  return NextResponse.json({
    has_job: true,
    job_id: job.id,
    type: job.type,
    payload: job.payload ?? {},
  });
}
