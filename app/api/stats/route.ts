import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { DAILY_TARGET } from "@/lib/seed";

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({
      stats: {
        date: today,
        target: DAILY_TARGET,
        submitted: 0,
        posted: 0,
        in_pipeline: 0,
        est_earnings_usd: 0,
      },
      configured: false,
    });
  }
  const { data: subs } = await sb
    .from("submissions")
    .select("id, earnings_usd")
    .gte("submitted_at", `${today}T00:00:00Z`);
  const { data: pipeline } = await sb
    .from("clips")
    .select("id, status")
    .not("status", "in", '("submitted","failed")');
  const { data: posted } = await sb
    .from("clips")
    .select("id")
    .eq("status", "posted")
    .gte("posted_at", `${today}T00:00:00Z`);

  return NextResponse.json({
    stats: {
      date: today,
      target: DAILY_TARGET,
      submitted: subs?.length ?? 0,
      posted: posted?.length ?? 0,
      in_pipeline: pipeline?.length ?? 0,
      est_earnings_usd: (subs ?? []).reduce(
        (s, r) => s + (r.earnings_usd ?? 0),
        0
      ),
    },
    configured: true,
  });
}
