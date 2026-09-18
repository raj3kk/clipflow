import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { createAutomationJob } from "@/lib/device_jobs";
import { validateClipPackage, buildAutomationPayload } from "@/lib/v2_workflow";
import { sendWakePush } from "@/lib/fcm";

/**
 * "Jab chahe" trigger — user dashboard se turant automation chalaye.
 *
 * POST /api/devices/:id/run-now
 *   { type?, video_url?, caption?, whop_submit_url? }  →  { job_id, via, ... }
 *
 * Clip package: body me aaye to wahi, nahi to device ke schedule_json.clip
 * (website pe saved). Bina valid clip package ke job nahi banta — pehle
 * website pe "Clip package" bharna hota hai.
 * Job turant queue hota hai (cap check ke saath), phir phone ko FCM
 * wake bhejne ki koshish hoti hai. FCM na ho to phone agle poll pe
 * (max ~15 min) job utha lega — via:"poll".
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
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const type = String(body.type ?? "automation");

  // Clip package: body override → device saved → error
  const { data: dev } = await sb
    .from("devices")
    .select("schedule_json, fcm_token")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!dev) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  const savedClip = (dev.schedule_json as Record<string, unknown> | null)?.clip;
  const clipInput =
    body.video_url || body.caption || body.whop_submit_url
      ? {
          video_url: body.video_url,
          caption: body.caption,
          whop_submit_url: body.whop_submit_url,
        }
      : savedClip;
  const clipCheck = validateClipPackage(clipInput);
  if (!clipCheck.ok || !clipCheck.pkg) {
    return NextResponse.json(
      {
        error:
          "Is manual (testing) run ke liye clip chahiye — upar fields me video URL + caption + Whop URL do, ya device card me manual clip save karo.",
        detail: clipCheck.error,
      },
      { status: 400 }
    );
  }
  const payload = {
    ...buildAutomationPayload(clipCheck.pkg),
    trigger: "manual",
  };

  const res = await createAutomationJob(
    sb,
    user.id,
    params.id,
    type,
    payload,
    { run_after: new Date().toISOString() }
  );
  if (!res.ok) {
    const { ok: _ok, code, ...rest } = res as { ok: false; code: number } & Record<string, unknown>;
    return NextResponse.json(rest, { status: code });
  }

  // phone jagao (best-effort)
  let via: "fcm" | "poll" = "poll";
  let fcm_sent = false;
  let reason: string | undefined;
  const fcmToken = (dev as { fcm_token?: string | null })?.fcm_token;
  if (fcmToken) {
    const r = await sendWakePush(fcmToken);
    via = r.via;
    fcm_sent = r.sent;
    reason = r.reason;
  } else {
    reason = "FCM token nahi hai — phone agle schedule pe job uthayega.";
  }

  return NextResponse.json({
    job_id: res.job_id,
    status: "queued",
    via,
    fcm_sent,
    reason,
  });
}
