import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { injectPendingStep } from "@/lib/live_step";

export const dynamic = "force-dynamic";

/**
 * Website se live job me step / stop inject karo (server-driven control).
 *
 * POST /api/devices/:id/live/inject   (session auth — website user)
 *   body: { job_id, step: {...} }  ya  { job_id, stop: true }
 *   → 200 { ok: true, step_id }
 *   → 401 signed out
 *   → 404 unknown device / unknown job
 *   → 409 job zinda nahi (step inject nahi ho sakta)
 *   → 400 galat body
 *
 * Device agli poll pe GET /api/devices/:id/live/step?job_id= se
 * {ok:true, step} / {ok:true, stop:true} payega (ek baar, phir clear).
 * Storage: device_jobs.payload.pending_step — koi nayi column nahi.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: device } = await sb
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const jobId = String(body.job_id ?? "").trim();
  if (!jobId) {
    return NextResponse.json({ error: "job_id is required." }, { status: 400 });
  }

  const res = await injectPendingStep(sb, {
    jobId,
    deviceId: params.id,
    userId: user.id,
    step: body.step,
    stop: body.stop === true,
    injectedBy: `website:${user.id}`,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.code });
  }
  return NextResponse.json({ ok: true, step_id: res.step_id });
}
