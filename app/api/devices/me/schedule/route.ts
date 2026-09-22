import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { DEFAULT_SCHEDULE } from "@/lib/device_jobs";

/**
 * Phone apna schedule fetch karta hai (har worker-run pe).
 * GET /api/devices/me/schedule  (X-Device-Id + X-Device-Key)
 *   → { schedule }
 */
export async function GET(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const { data: device } = await sb
    .from("devices")
    .select("schedule_json")
    .eq("id", ident.deviceId)
    .single();

  await touchDevice(ident.deviceId);
  return NextResponse.json({
    schedule: device?.schedule_json ?? DEFAULT_SCHEDULE,
  });
}
