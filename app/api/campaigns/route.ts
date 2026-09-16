import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";
import type { CampaignInput } from "@/lib/types";

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ campaigns: [], configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const { data, error } = await sb
    .from("campaigns")
    .select("*")
    .eq("user_id", userId)
    .eq("active", true)
    .order("payout_per_1k_usd", { ascending: false });
  if (error) {
    return NextResponse.json(
      { campaigns: [], configured: true, warning: error.message },
      { status: 200 }
    );
  }
  return NextResponse.json({ campaigns: data, configured: true });
}

export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured — cannot add campaigns yet." },
      { status: 503 }
    );
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const body = (await req.json()) as CampaignInput;
  const { id, name, sponsor } = body;
  if (!id || !name || !sponsor) {
    return NextResponse.json(
      { error: "id, name and sponsor are required." },
      { status: 400 }
    );
  }
  const { data, error } = await sb
    .from("campaigns")
    .insert({
      id,
      user_id: userId,
      name,
      sponsor,
      payout_per_1k_usd: body.payout_per_1k_usd ?? 0,
      budget_remaining_usd: body.budget_remaining_usd ?? null,
      min_payout_usd: body.min_payout_usd ?? null,
      max_payout_usd: body.max_payout_usd ?? null,
      min_seconds: body.min_seconds ?? 15,
      max_seconds: body.max_seconds ?? 60,
      requirements: body.requirements ?? "",
      caption_template: body.caption_template ?? "",
      hashtags: body.hashtags ?? [],
      brief_url: body.brief_url ?? null,
      campaign_url: body.campaign_url ?? null,
      joined: body.joined ?? false,
      join_status: body.join_status ?? "not_joined",
      active: body.active ?? true,
      scout_score: body.scout_score ?? null,
      notes: body.notes ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data }, { status: 201 });
}
