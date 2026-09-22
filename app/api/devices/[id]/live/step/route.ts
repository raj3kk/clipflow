import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * live_session ke pending step ka poll (Browser Agent v1, 2026-09-21).
 *
 * GET /api/devices/:id/live/step?job_id= (device auth: X-Device-Id + X-Device-Key)
 *   → 200 { ok: true }                    — koi pending step nahi
 *   → 200 { ok: true, step: {...} }       — (reserved: brain-driven step)
 *   → 200 { ok: true, stop: true }        — (reserved: loop rokne ka signal)
 *   → 401 bad device credentials
 *   → 404 job server pe nahi (cancelled/deleted) — phone lagataar 6 baar
 *       404 pe live loop exit karta hai.
 *
 * NOTE: server-driven step queue ka schema me koi column nahi hai, isliye
 * abhi ye route job-exists check + {ok:true} deta hai. Frames phir bhi
 * device_jobs.live_frame me jama hote rehte hain (live/frame route se).
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
  return NextResponse.json({ ok: true });
}
