import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";
import { DAILY_TARGET } from "@/lib/seed";
import type { DayStats } from "@/lib/types";

const PIPELINE_STATUSES = ["queued", "rendering", "preview", "approved", "scheduled", "posting"];

function emptyStats(today: string): DayStats {
  return {
    date: today,
    target: DAILY_TARGET,
    submitted: 0,
    posted: 0,
    in_pipeline: 0,
    est_earnings_usd: 0,
    per_campaign: [],
  };
}

export async function GET(req: Request) {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00Z`;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ stats: emptyStats(today), configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const [subs, posts, pipeline, campaigns, settings] = await Promise.all([
    sb
      .from("submissions")
      .select("id, earnings_usd")
      .eq("user_id", userId)
      .gte("submitted_at", dayStart),
    sb.from("posts").select("id").eq("user_id", userId).gte("posted_at", dayStart),
    sb.from("clips").select("id").eq("user_id", userId).in("status", PIPELINE_STATUSES),
    sb
      .from("campaigns")
      .select("id, name, budget_remaining_usd, payout_per_1k_usd")
      .eq("user_id", userId)
      .eq("active", true)
      .order("payout_per_1k_usd", { ascending: false }),
    sb.from("settings").select("daily_target").eq("user_id", userId).maybeSingle(),
  ]);

  const stats: DayStats = {
    date: today,
    target: settings.data?.daily_target ?? DAILY_TARGET,
    submitted: subs.data?.length ?? 0,
    posted: posts.data?.length ?? 0,
    in_pipeline: pipeline.data?.length ?? 0,
    est_earnings_usd: (subs.data ?? []).reduce(
      (s, r) => s + Number(r.earnings_usd ?? 0),
      0
    ),
    per_campaign: (campaigns.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      budget_remaining_usd: c.budget_remaining_usd,
      payout_per_1k_usd: Number(c.payout_per_1k_usd),
    })),
  };

  return NextResponse.json({ stats, configured: true });
}
