import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";

const DEFAULTS = {
  daily_target: 4,
  spacing_hours: 4,
  notify_email: null as string | null,
  pause_on_block: true,
  platforms: { instagram: true, tiktok: false, x: false, youtube: false },
  autopilot_enabled: true,
  auto_approve: true,
};

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ settings: DEFAULTS, configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  let { data, error } = await sb
    .from("settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    // First visit: create this user's row with defaults.
    const { data: created, error: cErr } = await sb
      .from("settings")
      .insert({ user_id: userId, ...DEFAULTS })
      .select()
      .single();
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    data = created;
  }
  return NextResponse.json({ settings: data, configured: true });
}

export async function PUT(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const _ident2 = await getRouteUserId(req);
  if ("error" in _ident2) return _ident2.error;
  const userId2 = _ident2.userId;
  const body = await req.json();
  const patch: Record<string, unknown> = { user_id: userId2, updated_at: new Date().toISOString() };
  for (const k of [
    "daily_target",
    "spacing_hours",
    "notify_email",
    "pause_on_block",
    "platforms",
    "autopilot_enabled",
    "auto_approve",
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  const { data, error } = await sb
    .from("settings")
    .upsert(patch, { onConflict: "user_id" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data });
}
