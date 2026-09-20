import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker-only: server-side campaign selection (2026-09-20).
 *
 * PROBLEM: VM ka egress proxy sustained HTTPS responses ko kaat deta hai
 * (IncompleteRead). Campaign selection ke liye VM ko multiple bulk queries
 * karne padte the (IDs → full rows → submissions → posts) — har ek flaky.
 *
 * SOLUTION: Selection Vercel pe hota hai (Supabase ke paas, reliable network).
 * VM sirf EK chhota request karta hai (~3KB response) — poora multi-query
 * dance khatam.
 *
 * Logic (planner_v2.py::pick_random_campaign ka mirror):
 * 1. MAIN_HUB ke active campaigns lao
 * 2. Pehle submit ho chuke campaigns exclude karo (permanent no-repeat rule)
 * 3. notes.eligible=false wale exclude karo
 * 4. brief_url (ya phone-verified video link) wale prefer karo
 * 5. Payout-weighted random pick
 * 6. Normalized campaign return karo
 *
 * Guarded by x-worker-secret.
 */

const MAIN_HUB_USER_ID = "00000000-0000-0000-0000-000000000000";

interface Campaign {
  id: string;
  name: string | null;
  sponsor: string | null;
  payout_per_1k_usd: number | null;
  budget_remaining_usd: number | null;
  min_seconds: number | null;
  max_seconds: number | null;
  requirements: string | null;
  caption_template: string | null;
  hashtags: string | null;
  brief_url: string | null;
  campaign_url: string | null;
  joined: boolean | null;
  join_status: string | null;
  notes: Record<string, unknown> | null;
}

function isEligible(c: Campaign): boolean {
  const n = c.notes;
  if (!n || typeof n !== "object") return true;
  return (n as Record<string, unknown>).eligible !== false;
}

function verifiedVideoUrl(c: Campaign): string | null {
  const n = c.notes;
  if (!n || typeof n !== "object") return null;
  const v = (n as Record<string, unknown>).verified_video_links;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0] as string;
  }
  return null;
}

function hasUsableBrief(c: Campaign): boolean {
  const url = verifiedVideoUrl(c) || (c.brief_url || "").trim();
  return url.length > 0;
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  let body: { user_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const userId = (body.user_id || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  // 1. Active campaigns (MAIN_HUB pool)
  const { data: campaigns, error: campErr } = await sb
    .from("campaigns")
    .select(
      "id,name,sponsor,payout_per_1k_usd,budget_remaining_usd," +
      "min_seconds,max_seconds,requirements,caption_template," +
      "hashtags,brief_url,campaign_url,joined,join_status,notes"
    )
    .eq("user_id", MAIN_HUB_USER_ID)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(50);

  if (campErr) {
    return NextResponse.json({ error: campErr.message }, { status: 500 });
  }

  // 2. Pehle submit ho chuke campaigns (permanent no-repeat)
  const submittedIds = new Set<string>();
  try {
    const { data: subs } = await sb
      .from("submissions")
      .select("post_id")
      .eq("user_id", userId)
      .limit(100);
    const pids = (subs ?? [])
      .map((r) => r.post_id as string)
      .filter(Boolean);
    if (pids.length > 0) {
      const { data: posts } = await sb
        .from("posts")
        .select("campaign_id")
        .in("id", pids)
        .limit(100);
      for (const p of posts ?? []) {
        if (p.campaign_id) submittedIds.add(p.campaign_id as string);
      }
    }
  } catch {
    // Exclusion fail = safe side pe kuch exclude nahi (planner bhi retry karega)
  }

  // 3. Filter: eligible + not submitted
  const eligible = ((campaigns ?? []) as unknown as Campaign[]).filter(
    (c) => isEligible(c) && !submittedIds.has(c.id)
  );

  if (eligible.length === 0) {
    return NextResponse.json({
      ok: false,
      reason: "no_campaign",
      detail: "Koi eligible campaign nahi (sab submit ho chuke ya ineligible)",
    });
  }

  // 4. Brief wale prefer karo (bina brief ke clip nahi ban sakta)
  const withBrief = eligible.filter(hasUsableBrief);
  const pool = withBrief.length > 0 ? withBrief : eligible;

  // 5. Payout-weighted random pick
  let totalWeight = 0;
  const weights = pool.map((c) => {
    const w = Math.max(0.1, Number(c.payout_per_1k_usd) || 0.1);
    totalWeight += w;
    return w;
  });
  let roll = Math.random() * totalWeight;
  let picked = pool[0];
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      picked = pool[i];
      break;
    }
  }

  // 6. Normalized campaign (sirf zaroori fields — ~3KB)
  const notes = (picked.notes || {}) as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    campaign: {
      id: picked.id,
      name: picked.name,
      sponsor: picked.sponsor,
      payout_per_1k_usd: picked.payout_per_1k_usd,
      budget_remaining_usd: picked.budget_remaining_usd,
      min_seconds: picked.min_seconds,
      max_seconds: picked.max_seconds,
      requirements: picked.requirements,
      caption_template: picked.caption_template,
      hashtags: picked.hashtags,
      brief_url: verifiedVideoUrl(picked) || picked.brief_url,
      campaign_url: picked.campaign_url,
      joined: picked.joined,
      join_status: picked.join_status,
      notes_eligible: notes.eligible !== false,
      has_brief: hasUsableBrief(picked),
    },
    pool_size: eligible.length,
    with_brief: withBrief.length,
    excluded_submitted: submittedIds.size,
  });
}
