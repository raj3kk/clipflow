import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin";

/**
 * Main Hub — Daily Campaign Pool status + agents.
 * GET: pool status + agent list
 * POST: trigger pool refresh (calls worker via internal endpoint)
 */

const MAIN_HUB_USER_ID = "00000000-0000-0000-0000-000000000000";

const AGENTS = [
  { name: "Discovery Agent", role: "Roz 25 campaigns nikalta hai (server-side, bina sign-in)", status: "active", lastRun: null as string | null },
  { name: "Brief Agent", role: "Har campaign ka full brief nikalta hai (caption, hashtag, requirements)", status: "active", lastRun: null as string | null },
  { name: "Cleanup Agent", role: "24h purane campaigns auto-delete karta hai", status: "active", lastRun: null as string | null },
  { name: "Monitor Agent", role: "Problems detect karke auto-fix karta hai", status: "active", lastRun: null as string | null },
];

export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const { data: pool } = await sb
    .from("campaigns")
    .select("id,created_at")
    .eq("user_id", MAIN_HUB_USER_ID)
    .eq("active", true)
    .order("created_at", { ascending: true });

  const count = pool?.length ?? 0;
  let ageHours = 999;
  if (pool && pool.length > 0) {
    const oldest = new Date(pool[0].created_at).getTime();
    ageHours = (Date.now() - oldest) / 3600000;
  }

  return NextResponse.json({
    poolCount: count,
    poolAgeHours: ageHours,
    needsRefresh: count === 0 || ageHours >= 24,
    agents: AGENTS,
  });
}

export async function POST() {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  // Manual refresh request — mainhub.py ka daily cron isko dekhke force refresh karega
  // (1h ke andar). Event activity_log me dalte hain.
  const { error } = await sb.from("activity_log").insert({
    actor: "admin",
    event: "hub_refresh_requested",
    detail: { text: "Admin panel se manual refresh", at: new Date().toISOString() },
  });

  if (error) {
    return NextResponse.json({ error: "Request save nahi hui: " + error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: "Refresh request bhej di — agle 1h me pool refresh ho jayega (daily cron).",
    count: 0,
  });
}
