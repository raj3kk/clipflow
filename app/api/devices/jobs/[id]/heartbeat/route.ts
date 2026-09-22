import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getLatestRelease } from "@/lib/app_release";
import { sanitizeLiveEvents, mergeLiveSteps } from "@/lib/device_jobs";

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
 * POST /api/devices/jobs/:id/heartbeat  { step?: string, sessions?: { ig?: boolean, whop?: boolean }, frame?: string, events?: Array<{t, step, phase?, msg?, ok?}> }  →  { ok: true }
 *
 * 2026-09-22 OBSERVABILITY (ground-zero rebuild):
 *   - `frame`: base64 JPEG string (~≤270KB chars) → device_jobs.live_frame
 *     (text). Live page pe phone ka latest frame dikhta hai.
 *   - `events`: max 20 per call, har entry {t: ISO, step, phase?, msg?, ok?}
 *     → device_jobs.live_steps (jsonb) me append, last 120 rakhi jati hain.
 *   Dono terminal-job path pe bhi likhe jate hain (forensics) — status rules
 *   bilkul unchanged (koi resurrection nahi).
 *
 * p42: step ab 280 chars tak (pehle 64) — brain ki poori reasoning
 * (FAILED_NO_ACTION detail, tried candidates) Live page pe dikhegi.
 * current_step column text hai, isliye safe hai.
 *
 * sessions (2026-09-20 WP3 — WebView session persistence): phone batata hai
 * "maine abhi authenticated IG/Whop page dekha". true aane pe devices ki
 * ig_session_ok_at / whop_session_ok_at refresh hoti hai. Sirf boolean
 * signals — koi cookie/token server pe nahi aata.
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
  let sessions: { ig?: boolean; whop?: boolean } | null = null;
  let frame: string | null = null;
  let events: ReturnType<typeof sanitizeLiveEvents> = [];
  try {
    const body = await req.json();
    if (body && typeof body.step === "string") {
      step = body.step.slice(0, 280) || null;
    }
    if (body && body.sessions && typeof body.sessions === "object") {
      const s = body.sessions as Record<string, unknown>;
      sessions = {
        ig: s.ig === true ? true : undefined,
        whop: s.whop === true ? true : undefined,
      };
      if (sessions.ig === undefined && sessions.whop === undefined) sessions = null;
    }
    // 2026-09-22 observability: live frame (base64 JPEG, ~≤270KB chars)
    if (body && typeof body.frame === "string" && body.frame.length > 64) {
      frame = body.frame.slice(0, 280000);
    }
    // 2026-09-22 observability: step transition events → live_steps
    if (body) events = sanitizeLiveEvents(body.events, 20);
  } catch {
    /* body optional */
  }

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status, heartbeat_count, live_steps")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();

  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  const now = new Date().toISOString();
  // Observability fields — terminal path pe bhi (forensics), status untouched.
  const obsUpdate: Record<string, unknown> = {};
  if (frame) obsUpdate.live_frame = frame;
  if (events.length > 0) {
    obsUpdate.live_steps = mergeLiveSteps(
      (job as { live_steps?: unknown }).live_steps,
      events
    );
  }
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
        ...obsUpdate,
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
    ...obsUpdate,
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

  // WebView session signals (WP3): true aaya to device timestamps refresh.
  // Best-effort — fail ho to heartbeat phir bhi ok hai.
  if (sessions) {
    try {
      const sessUpdate: Record<string, unknown> = {};
      if (sessions.ig) sessUpdate.ig_session_ok_at = now;
      if (sessions.whop) sessUpdate.whop_session_ok_at = now;
      if (Object.keys(sessUpdate).length > 0) {
        await sb.from("devices").update(sessUpdate).eq("id", ident.deviceId);
      }
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status: update.status ?? job.status,
    heartbeat_count: update.heartbeat_count,
    current_step: step,
    // WP4 piggyback: run ke dauraan phone ko pata chale naya release aaya
    // (download bg me hoga; install prompt sirf idle pe).
    app_update: await getLatestRelease(sb),
  });
}
