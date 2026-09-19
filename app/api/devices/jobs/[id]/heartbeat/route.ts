import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone job execution ke dauraan har ~5 min me heartbeat bhejta hai
 * (heartbeat-capable app versions, Worker D se). Har heartbeat:
 *   - last_heartbeat = now
 *   - heartbeat_count + 1   (0 = purana app / kabhi heartbeat nahi aaya)
 *   - current_step = body.step (optional, e.g. "uploading") — Live page pe dikhta hai
 *   - status → "running" (confirm) — SIRF jab job dispatched/running ho.
 *
 * Round-7 (Worker A) guards:
 *   - terminal job (succeeded/failed/timeout/cancelled) pe heartbeat use
 *     wapas "running" NAHI karta (resurrection bug fix) — sirf heartbeat
 *     fields refresh, status chhoda jata hai.
 *   - 'queued' job pe heartbeat status queued hi rakhta hai taaki phone
 *     use dobara claim kar sake (requeue-race deadlock fix).
 *
 * Purane app versions heartbeat NAHI bhejte — unke liye last_heartbeat sirf
 * claim-time pe set hota hai. reconcileStaleJobs (lib/device_jobs.ts) is
 * farak ko samajhta hai: heartbeat_count>0 → 10 min cutoff, 0 → 45 min
 * legacy cutoff (claim-time se). Watchdog: pipeline_watch.py har 1 min +
 * schedule-tick har 15 min + jobs/next har poll.
 *
 * POST /api/devices/jobs/:id/heartbeat  { step?: string }  →  { ok: true }
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let step: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.step === "string") {
      step = body.step.slice(0, 64) || null;
    }
  } catch {
    /* body optional */
  }

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status, heartbeat_count")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();

  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  const now = new Date().toISOString();
  // Round-7 (Worker A) fix: terminal job (succeeded/failed/timeout/cancelled)
  // pe late heartbeat aaye (duplicate worker / race) to use wapas "running"
  // mat karo — resurrection se Live page flicker hota hai aur reconcile
  // confuse hota hai. Sirf heartbeat fields refresh karo, status chhodo.
  if (["succeeded", "cancelled", "failed", "timeout"].includes(job.status)) {
    await sb
      .from("device_jobs")
      .update({
        last_heartbeat: now,
        heartbeat_count: (job.heartbeat_count ?? 0) + 1,
      })
      .eq("id", job.id);
    await touchDevice(ident.deviceId);
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      status: job.status,
      terminal: true,
    });
  }
  const update: Record<string, unknown> = {
    last_heartbeat: now,
    heartbeat_count: (job.heartbeat_count ?? 0) + 1,
  };
  // "running" sirf tab jab job dispatched/running hai. 'queued' job pe
  // heartbeat ka matlab phone abhi bhi purana attempt pakde hai (requeue ke
  // baad) — status queued hi rehne do taaki phone use dobara claim kar sake.
  // (Pehle har heartbeat status="running" kar deta tha → phone re-claim nahi
  // kar pata tha aur job atki rehti thi.)
  if (["dispatched", "running"].includes(job.status)) {
    update.status = "running";
  }
  if (step) update.current_step = step;
  await sb.from("device_jobs").update(update).eq("id", job.id);
  await touchDevice(ident.deviceId);

  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status: update.status ?? job.status,
    heartbeat_count: update.heartbeat_count,
    current_step: step,
  });
}
