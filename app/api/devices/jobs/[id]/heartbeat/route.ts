import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone har ~5-10 min me heartbeat bhejta hai jab job chal rahi ho
 * (AutomationWorker me heartbeat loop). 45 min tak heartbeat na aaye to
 * job wapas queue me dal di jati hai (reconcileStaleJobs, lib/device_jobs.ts —
 * schedule-tick har 15 min + jobs/next har poll pe chalata hai).
 *
 * POST /api/devices/jobs/:id/heartbeat  →  { ok: true }
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
    .select("id, status")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();

  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  const now = new Date().toISOString();
  await sb
    .from("device_jobs")
    .update({ last_heartbeat: now, status: "running" })
    .eq("id", job.id);
  await touchDevice(ident.deviceId);

  return NextResponse.json({ ok: true, job_id: job.id, status: "running" });
}
