import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

export async function GET() {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ clips: [], configured: false });
  }
  const { data, error } = await sb
    .from("clips")
    .select("*, campaigns(name)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clips: data, configured: true });
}

export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured — cannot queue render jobs yet." },
      { status: 503 }
    );
  }
  const body = await req.json();
  const { campaign_id, source_url, start_sec, end_sec, hook_text, caption } =
    body;
  if (!campaign_id || !source_url || start_sec == null || end_sec == null) {
    return NextResponse.json(
      { error: "campaign_id, source_url, start_sec, end_sec are required." },
      { status: 400 }
    );
  }
  if (end_sec - start_sec < 15 || end_sec - start_sec > 60) {
    return NextResponse.json(
      { error: "Clip must be 15–60 seconds." },
      { status: 400 }
    );
  }
  const { data, error } = await sb
    .from("clips")
    .insert({
      campaign_id,
      source_url,
      start_sec,
      end_sec,
      hook_text: hook_text ?? null,
      caption: caption ?? null,
      status: "queued",
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data }, { status: 201 });
}
