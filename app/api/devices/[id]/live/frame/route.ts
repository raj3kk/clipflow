import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * live_session job ka frame post (Browser Agent v1, 2026-09-21).
 *
 * POST /api/devices/:id/live/frame (device auth: X-Device-Id + X-Device-Key)
 *   body: { job_id, frame }  (frame = base64 JPEG, phone ≤200KB bhejta hai)
 *   → 200 { ok: true, job_id }
 *   → 400 job_id/frame missing ya frame bahut bada
 *   → 401 bad device credentials, 404 job unknown (phone loop exit karta hai)
 *
 * Storage: device_jobs.live_frame (wahi column jo heartbeat ka `frame`
 * field bhi likhta hai — admin Runs UI dono se latest dikhata hai).
 */
export async function POST(
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const jobId = String(body.job_id ?? "").trim();
  const frame = typeof body.frame === "string" ? body.frame : "";
  if (!jobId) {
    return NextResponse.json({ error: "job_id is required." }, { status: 400 });
  }
  if (!frame) {
    return NextResponse.json({ error: "frame is required." }, { status: 400 });
  }
  // ~750KB chars ≈ 550KB binary — phone 200KB bhejta hai, headroom ke saath
  if (frame.length > 750 * 1024) {
    return NextResponse.json({ error: "frame too large." }, { status: 400 });
  }

  const { data: updated, error } = await sb
    .from("device_jobs")
    .update({
      live_frame: frame,
      last_heartbeat: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("device_id", ident.deviceId)
    .select("id")
    .maybeSingle();

  if (error || !updated) {
    // Phone isko "job server pe nahi raha" manta hai → live loop exit.
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  await touchDevice(ident.deviceId);
  return NextResponse.json({ ok: true, job_id: jobId });
}
