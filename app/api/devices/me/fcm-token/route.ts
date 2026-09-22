import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone apna FCM push token register karta hai (WakeService.onNewToken).
 * POST /api/devices/me/fcm-token  (X-Device-Id + X-Device-Key)
 *   { fcm_token } → { ok: true }
 *
 * Token se server Run Now / wake pe seedha phone ko push bhej sakta hai.
 */
export async function POST(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const token = String(body.fcm_token ?? "").trim();
  if (!token || token.length > 500) {
    return NextResponse.json({ error: "fcm_token is required." }, { status: 400 });
  }

  await sb
    .from("devices")
    .update({ fcm_token: token })
    .eq("id", ident.deviceId);

  await touchDevice(ident.deviceId);
  return NextResponse.json({ ok: true });
}
