import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

const DEFAULTS = {
  id: 1,
  daily_target: 4,
  spacing_hours: 4,
  notify_email: null as string | null,
  pause_on_block: true,
  platforms: { instagram: true, tiktok: false, x: false, youtube: false },
};

export async function GET() {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ settings: DEFAULTS, configured: false });
  }
  const { data, error } = await sb
    .from("settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data ?? DEFAULTS, configured: true });
}

export async function PUT(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const patch: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  for (const k of [
    "daily_target",
    "spacing_hours",
    "notify_email",
    "pause_on_block",
    "platforms",
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  const { data, error } = await sb
    .from("settings")
    .upsert(patch, { onConflict: "id" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data });
}
