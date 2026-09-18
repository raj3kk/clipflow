import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * PhoneAgent device authentication.
 *
 * Phone har request me do headers bhejta hai:
 *   X-Device-Id  — devices.id
 *   X-Device-Key — enroll ke waqt mili api_key (raw, phone ke encrypted
 *                  storage me; server pe sirf sha256 hash)
 *
 * Session cookies yahan kaam nahi karte (phone ka apna auth hai).
 */

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type DeviceIdentity =
  | { deviceId: string; userId: string; device: Record<string, unknown> }
  | { error: NextResponse };

export async function getDeviceIdentity(req: Request): Promise<DeviceIdentity> {
  const key = req.headers.get("x-device-key") ?? "";
  const deviceId = req.headers.get("x-device-id") ?? "";
  if (!key || !deviceId) {
    return {
      error: NextResponse.json(
        { error: "Missing device credentials (X-Device-Id / X-Device-Key)." },
        { status: 401 }
      ),
    };
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return {
      error: NextResponse.json(
        { error: "Supabase not configured." },
        { status: 503 }
      ),
    };
  }
  const { data, error } = await sb
    .from("devices")
    .select("*")
    .eq("id", deviceId)
    .single();
  if (error || !data) {
    return {
      error: NextResponse.json({ error: "Unknown device." }, { status: 401 }),
    };
  }
  if (data.status !== "active") {
    return {
      error: NextResponse.json(
        { error: `Device not active (status: ${data.status}).` },
        { status: 403 }
      ),
    };
  }
  const want = Buffer.from(String(data.api_key_hash), "hex");
  const got = Buffer.from(hashApiKey(key), "hex");
  if (
    want.length !== got.length ||
    !timingSafeEqual(want, got)
  ) {
    return {
      error: NextResponse.json({ error: "Invalid device key." }, { status: 401 }),
    };
  }
  return { deviceId: data.id, userId: data.user_id, device: data };
}

/** Har device request pe last_seen update (fire-and-forget). */
export async function touchDevice(deviceId: string) {
  const sb = getSupabase();
  if (!sb) return;
  await sb
    .from("devices")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", deviceId);
}
