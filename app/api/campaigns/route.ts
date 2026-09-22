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
  // MANUAL ADD BAND (2026-09-20 — user order): campaigns sirf phone se
  // auto-discover honge (har 24h me 15). Manual add ab allowed nahi hai.
  return NextResponse.json(
    {
      error:
        "Manual campaign add band hai. Campaigns har 24h me phone se automatically discover hote hain (Content Rewards se 15 campaigns).",
    },
    { status: 403 }
  );
}
