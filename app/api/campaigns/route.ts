import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { SEED_CAMPAIGNS } from "@/lib/seed";

export async function GET() {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ campaigns: SEED_CAMPAIGNS, configured: false });
  }
  const { data, error } = await sb
    .from("campaigns")
    .select("*")
    .eq("active", true)
    .order("payout_per_1k_usd", { ascending: false });
  if (error) {
    return NextResponse.json(
      { campaigns: SEED_CAMPAIGNS, configured: true, warning: error.message },
      { status: 200 }
    );
  }
  return NextResponse.json({ campaigns: data, configured: true });
}
