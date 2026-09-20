import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { logActivity } from "@/lib/device_jobs";

/**
 * POST /api/devices/jobs/[id]/release  (X-Device-Id + X-Device-Key headers)
 *
 * WP4 (2026-09-20): phone ne job claim ki (dispatched) lekin force_update
 * gate ne run start nahi hone diya (stale brain naye jobs pe nahi chalega).
 * Claim wapas chhodo → status='queued' taaki update ke baad turant uth sake.
 *
 * result route ka "blocked" yahan GALAT hota — wo 24h auto-pause lagata hai
 * (IG action-block rule). Release me koi pause nahi, koi mastery penalty nahi:
 * job ne chali hi nahi.
 *
 * Sirf dispatched/running (non-terminal, heartbeat nahi aaya) release hoti
 * hai. Idempotent: pehle se queued/terminal ho to 200 + {released:false}.
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

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status, type, user_id")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  if (!["dispatched", "running"].includes(job.status)) {
    return NextResponse.json({ ok: true, released: false, status: job.status });
  }

  await sb
    .from("device_jobs")
    .update({ status: "queued" })
    .eq("id", job.id);

  try {
    await logActivity(
      sb,
      ident.userId,
      ident.deviceId,
      "job_released",
      `Job ${job.id} (${job.type}) released: force_update gate — update ke baad dobara uthegi.`
    );
  } catch {
    /* best-effort */
  }
  try {
    await touchDevice(ident.deviceId, req.headers.get("x-app-version"));
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ ok: true, released: true });
}
