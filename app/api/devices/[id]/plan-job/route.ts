import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob } from "@/lib/device_jobs";
import { validateClipPackage, buildAutomationPayload } from "@/lib/v2_workflow";

/**
 * Planner enqueue — VM/offline planner ClipPackage banake turant phone automation
 * queue kar sakta hai, bina website UI khole.
 *
 * POST /api/devices/:id/plan-job  (x-worker-secret)
 *   { video_url, caption, whop_submit_url }  →  { ok:true, job_id, deduped }
 *
 * - validateClipPackage fail → 400 (Hinglish error)
 * - device unknown → 404
 * - device paused/not-active → 409
 * - cap (4/24h) full → 429
 * - idempotency_key = plan:<device_id>:<sha256(video_url)[:16]> —
 *   same video dobara plan ho to purana job wapas milta hai (deduped:true),
 *   queue me duplicate nahi banta.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body me JSON chahiye: { video_url, caption, whop_submit_url }." },
      { status: 400 }
    );
  }

  const clipCheck = validateClipPackage(body);
  if (!clipCheck.ok || !clipCheck.pkg) {
    return NextResponse.json(
      {
        error:
          "Clip package poora nahi hai. video_url (direct MP4 link), caption (text + hashtags) aur whop_submit_url (Whop submit page) — teeno chahiye.",
        detail: clipCheck.error,
      },
      { status: 400 }
    );
  }
  const pkg = clipCheck.pkg;
  const campaignSlug =
    typeof (body as Record<string, unknown>).campaign_slug === "string"
      ? ((body as Record<string, unknown>).campaign_slug as string).trim() || null
      : null;

  // device ka owner (user_id) nikaalo — createAutomationJob khud status/cap check karta hai
  const { data: device } = await sb
    .from("devices")
    .select("id, user_id, status")
    .eq("id", params.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const hash = createHash("sha256")
    .update(pkg.video_url)
    .digest("hex")
    .slice(0, 16);
  const payload = {
    ...buildAutomationPayload(pkg, { campaign_slug: campaignSlug ?? undefined }),
    trigger: "planner",
  };
  const res = await createAutomationJob(sb, device.user_id, device.id, "automation", payload, {
    idempotency_key: `plan:${device.id}:${hash}`,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.code ?? 500 });
  }
  return NextResponse.json({
    ok: true,
    job_id: res.job_id,
    deduped: res.deduped === true,
  });
}
