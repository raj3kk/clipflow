import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { validateSchedule, DEFAULT_SCHEDULE } from "@/lib/device_jobs";

/**
 * Device ka automation schedule dekho / badlo (dashboard).
 *
 * GET  /api/devices/:id/schedule  → { schedule }
 * PUT  /api/devices/:id/schedule  { schedule } → { ok, schedule }
 *
 * Schedule phone har worker-run pe fetch karta hai (GET /api/devices/me/schedule)
 * aur WorkManager usi hisaab se lagata hai:
 *   interval → har N ghante ;  times → roz un fixed times pe.
 */
export async function GET(
  _req: Request,
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
  const { data: device } = await sb
    .from("devices")
    .select("id, schedule_json")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ schedule: device.schedule_json ?? DEFAULT_SCHEDULE });
}

export async function PUT(
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const v = validateSchedule(body.schedule);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 });
  }

  const { data, error } = await sb
    .from("devices")
    .update({ schedule_json: v.schedule })
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("id")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, schedule: v.schedule });
}
