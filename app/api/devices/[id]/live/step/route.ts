import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { takePendingStep } from "@/lib/live_step";

export const dynamic = "force-dynamic";

/**
 * live_session ke pending step ka poll (Browser Agent v1, 2026-09-21;
 * server-driven queue 2026-09-27).
 *
 * GET /api/devices/:id/live/step?job_id= (device auth: X-Device-Id + X-Device-Key)
 *   → 200 { ok: true }                    — koi pending step nahi
 *   → 200 { ok: true, step: {...} }       — website se inject hua step
 *                                           (ek baar milta hai, phir clear)
 *   → 200 { ok: true, stop: true }        — loop rokne ka signal (ek baar)
 *   → 401 bad device credentials
 *   → 404 job server pe nahi (cancelled/deleted) — phone lagataar 6 baar
 *       404 pe live loop exit karta hai.
 *
 * Queue storage: device_jobs.payload.pending_step (koi nayi column nahi;
 * lib/live_step.ts). Website POST /api/devices/:id/live/inject se dalta hai.
 * Frames device_jobs.live_frame me jama hote rehte hain (live/frame route se).
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;
  if (ident.deviceId !== params.id) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const jobId = new URL(req.url).searchParams.get("job_id")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "job_id is required." }, { status: 400 });
  }

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status")
    .eq("id", jobId)
    .eq("device_id", ident.deviceId)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  await touchDevice(ident.deviceId);

  // Website se inject hua pending step ho to ek baar dekar clear karo.
  const pending = await takePendingStep(sb, {
    jobId: job.id,
    deviceId: ident.deviceId,
  });
  if (pending?.kind === "stop") {
    return NextResponse.json({ ok: true, stop: true });
  }
  if (pending?.kind === "step") {
    return NextResponse.json({ ok: true, step: pending.step });
  }
  return NextResponse.json({ ok: true });
}
