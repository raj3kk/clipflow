import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

export async function GET() {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ submissions: [], configured: false });
  }
  const { data, error } = await sb
    .from("submissions")
    .select("*, clips(campaign_id)")
    .order("submitted_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ submissions: data, configured: true });
}

export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }
  const body = await req.json();
  const { clip_id, instagram_url, whop_status } = body;
  if (!clip_id || !instagram_url) {
    return NextResponse.json(
      { error: "clip_id and instagram_url are required." },
      { status: 400 }
    );
  }
  const { data, error } = await sb
    .from("submissions")
    .insert({
      clip_id,
      instagram_url,
      whop_status: whop_status ?? "submitted",
      submitted_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await sb.from("clips").update({ status: "submitted" }).eq("id", clip_id);
  return NextResponse.json({ submission: data }, { status: 201 });
}
