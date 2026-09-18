import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { createAutomationJob } from "@/lib/device_jobs";
import { sendWakePush } from "@/lib/fcm";

/**
 * "Jab chahe" trigger — user dashboard se turant automation chalaye.
 *
 * POST /api/devices/:id/run-now
 *   { type?, payload? }  →  { job_id, via: "fcm"|"poll", fcm_sent }
 *
 * Job turant queue hota hai (cap check ke saath), phir phone ko FCM
 * wake bhejne ki koshish hoti hai. FCM na ho to phone agle poll pe
 * (max apne schedule interval me) job utha lega — via:"poll".
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

  const res = await createAutomationJob(
    sb,
    user.id,
    params.id,
    type,
    (body.payload as Record<string, unknown>) ?? {},
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
  const { data: device } = await sb
    .from("devices")
    .select("fcm_token")
    .eq("id", params.id)
    .single();
  if (device?.fcm_token) {
    const r = await sendWakePush(device.fcm_token);
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
