import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { hashApiKey, touchDevice } from "@/lib/device_auth";

/**
 * POST /api/devices/me/presence
 *
 * PhoneAgent ka Sleep/Online toggle. Phone apni presence server ko batata hai:
 *   { "state": "sleeping" } → status='paused' (manual sleep, paused_until untouched)
 *   { "state": "online"   } → manual sleep thi to status='active' wapas;
 *                              action-block pause (paused_until set) ko chhedata nahi.
 *
 * Auth: X-Device-Id + X-Device-Key (sha256 compare) — LEKIN status check NAHI.
 * Paused device bhi hit kar sakta hai taaki sleeping phone khud ko wapas
 * online kar sake. Device key khud ownership ka proof hai (user_id check nahi).
 */
export async function POST(req: Request) {
  const key = req.headers.get("x-device-key") ?? "";
  const deviceId = req.headers.get("x-device-id") ?? "";
  if (!key || !deviceId) {
    return NextResponse.json(
      { error: "Missing device credentials (X-Device-Id / X-Device-Key)." },
      { status: 401 }
    );
  }

  let body: { state?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const state = body.state;
  if (state !== "online" && state !== "sleeping") {
    return NextResponse.json(
      { error: 'state must be "online" or "sleeping".' },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data, error } = await sb
    .from("devices")
    .select("id, status, paused_until, api_key_hash")
    .eq("id", deviceId)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // NOTE: no status check — paused/sleeping device ko bhi wapas online aana hai.
  const want = Buffer.from(String(data.api_key_hash), "hex");
  const got = Buffer.from(hashApiKey(key), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return NextResponse.json({ error: "Invalid device key." }, { status: 401 });
  }

  let patch: Record<string, string | null> = {};
  if (state === "sleeping") {
    // Manual sleep → paused. Action-block ka paused_until set hai to usko haath mat lagao.
    patch = { status: "paused" };
    if (!data.paused_until) patch.paused_until = null;
  } else {
    // "online" → sirf tab active karo jab paused_until NULL ho (manual sleep thi).
    // Action-block pause (paused_until set) pe status chhedo mat.
    if (data.paused_until) {
      await touchDevice(deviceId);
      return NextResponse.json({
        ok: true,
        status: "paused",
        note: "action-block pause active",
      });
    }
    patch = { status: "active", paused_until: null };
  }

  const { error: upErr } = await sb
    .from("devices")
    .update(patch)
    .eq("id", deviceId);
  if (upErr) {
    return NextResponse.json(
      { error: "Presence update failed." },
      { status: 500 }
    );
  }
  await touchDevice(deviceId);
  return NextResponse.json({
    ok: true,
    status: state === "online" ? "active" : "paused",
  });
}
