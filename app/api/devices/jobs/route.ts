import { NextResponse } from "next/server";
import { getRouteUserId } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Naya automation job banao (dashboard / agent / worker).
 *
 * POST /api/devices/jobs
 *   { device_id, type, payload, idempotency_key? }
 *
 * CAP (user-set 2026-09-18): MAX 4 automations per rolling 2 days.
 * Cap cross hone pe 429 — phone ko kabhi 5th job milega hi nahi.
 */
const CAP_COUNT = 4;
const CAP_WINDOW_HOURS = 48;

export async function POST(req: Request) {
  const ident = await getRouteUserId(req);
  if ("error" in ident) return ident.error;
  const userId = ident.userId;

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
  const deviceId = String(body.device_id ?? "");
  const type = String(body.type ?? "custom");
  if (!deviceId) {
    return NextResponse.json({ error: "device_id is required." }, { status: 400 });
  }

  const { data: device } = await sb
    .from("devices")
    .select("id, status")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  if (device.status !== "active") {
    return NextResponse.json(
      { error: `Device not active (status: ${device.status}).` },
      { status: 409 }
    );
  }

  // Cap: last 48h me live/succeeded jobs gino
  const since = new Date(
    Date.now() - CAP_WINDOW_HOURS * 3600 * 1000
  ).toISOString();
  const { count, error: countErr } = await sb
    .from("device_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("status", ["queued", "dispatched", "running", "succeeded"]);
  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 });
  }
  if ((count ?? 0) >= CAP_COUNT) {
    return NextResponse.json(
      {
        error: `Automation cap reached: max ${CAP_COUNT} per ${CAP_WINDOW_HOURS}h.`,
        cap: CAP_COUNT,
        window_hours: CAP_WINDOW_HOURS,
      },
      { status: 429 }
    );
  }

  const { data: job, error: jobErr } = await sb
    .from("device_jobs")
    .insert({
      user_id: userId,
      device_id: deviceId,
      type,
      payload: (body.payload as Record<string, unknown>) ?? {},
      idempotency_key: body.idempotency_key
        ? String(body.idempotency_key)
        : null,
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    const msg = jobErr?.message ?? "Job create failed.";
    // idempotency_key duplicate → pehle wala job wapas do
    if (jobErr?.code === "23505" && body.idempotency_key) {
      const { data: existing } = await sb
        .from("device_jobs")
        .select("id, status")
        .eq("idempotency_key", String(body.idempotency_key))
        .eq("user_id", userId)
        .single();
      if (existing) {
        return NextResponse.json({
          job_id: existing.id,
          status: existing.status,
          deduped: true,
        });
      }
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ job_id: job.id, status: "queued" });
}
