import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";
import { requireWorkerAuth } from "@/lib/worker_auth";

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ submissions: [], configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const { data, error } = await sb
    .from("submissions")
    .select("*, clips(campaign_id), posts(id, instagram_url, posted_at)")
    .eq("user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ submissions: data, configured: true });
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const _wu = new URL(req.url).searchParams.get("user_id");
  if (!_wu) {
    return NextResponse.json(
      { error: "user_id query param is required for worker calls." },
      { status: 400 }
    );
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { clip_id, instagram_url, whop_status, keep_live_until, post_id } = body;
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
      user_id: _wu,
      instagram_url,
      whop_status: whop_status ?? "submitted",
      submitted_at: new Date().toISOString(),
      keep_live_until: keep_live_until ?? null,
      post_id: post_id ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await sb.from("clips").update({ status: "submitted" }).eq("id", clip_id).eq("user_id", _wu);
  return NextResponse.json({ submission: data }, { status: 201 });
}
