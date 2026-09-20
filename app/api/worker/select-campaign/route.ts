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

/**
 * Campaign classification (2026-09-20 compliance hardening):
 * - clip_ready:    clip ban sakta hai — pick pool me jayega
 * - join_only:     join kar sakte hain, clip ke liye asset/caption ready nahi
 * - needs_phone:   user ka action chahiye (payment decision / bio link / caption)
 * - ugc_unsupported: original UGC (face-cam/talking-head) mangta hai —
 *                  automation se banaya hua clip compliant nahi hoga
 */
type CampaignClass = "clip_ready" | "join_only" | "needs_phone" | "ugc_unsupported";

function classify(c: Campaign): { cls: CampaignClass; reasons: string[] } {
  const n = (c.notes || {}) as Record<string, unknown>;
  const req = (c.requirements || "").toLowerCase();
  const nameL = (c.name || "").toLowerCase();

  // 1. Payment-looking join → user decide karega (auto-buy KABHI nahi)
  if (
    n.join_paid === true ||
    /\$\s*\d+\s*(\/\s*(mo|month)|per\s*month)|\/mo\b|paid membership|subscription required/i.test(
      req + " " + nameL
    )
  ) {
    return { cls: "needs_phone", reasons: ["payment-looking join — user decide karega"] };
  }

  // 2. Original UGC (face-cam / talking-head / khud record karo) → automation se nahi
  if (
    /original\s+(video|content)|film\s+yourself|record\s+yourself|face[\s-]?cam|talking[\s-]?head/i.test(
      req
    )
  ) {
    return { cls: "ugc_unsupported", reasons: ["original UGC required — automation compliant nahi"] };
  }

  // 3. Required bio link set nahi → user ka kaam (IG app me manual)
  const bioLink = n.required_bio_link as string | undefined;
  const bioSet = n.bio_link_set === true;
  if (bioLink && !bioSet) {
    return {
      cls: "needs_phone",
      reasons: [`required bio link set nahi: ${String(bioLink).slice(0, 60)}`],
    };
  }

  // 4. Bina usable brief ke clip nahi ban sakta → join_only
  if (!hasUsableBrief(c)) {
    return { cls: "join_only", reasons: ["koi verified video asset nahi"] };
  }

  // 5. Caption exact/normalized nahi → galat caption = reject risk
  const cap = (c.caption_template || "").trim();
  if (cap.length < 20 || /\[.*(insert|your|here|brand|tag).*\]/i.test(cap)) {
    return { cls: "needs_phone", reasons: ["caption exact/normalized nahi hai"] };
  }

  return { cls: "clip_ready", reasons: [] };
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
  // FAIL-CLOSED: exclusion data load na ho to KOI pick nahi — repeat ka
  // risk lene se achha hai aaj ka run skip ho jaye.
  const submittedIds = new Set<string>();
  try {
    const { data: subs, error: subErr } = await sb
      .from("submissions")
      .select("post_id")
      .eq("user_id", userId)
      .limit(100);
    if (subErr) throw new Error(subErr.message);
    const pids = (subs ?? [])
      .map((r) => r.post_id as string)
      .filter(Boolean);
    if (pids.length > 0) {
      const { data: posts, error: postErr } = await sb
        .from("posts")
        .select("campaign_id")
        .in("id", pids)
        .limit(100);
      if (postErr) throw new Error(postErr.message);
      for (const p of posts ?? []) {
        if (p.campaign_id) submittedIds.add(p.campaign_id as string);
      }
    }
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reason: "no_repeat_unsafe",
      detail:
        "Submitted-campaign exclusion load nahi hui — repeat risk pe koi campaign nahi chunenge. " +
        String((e as Error)?.message ?? e).slice(0, 120),
    });
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

  // 4. Classify — sirf clip_ready pool me jayega. join_only /
  // needs_phone / ugc_unsupported kabhi clip ke liye pick nahi honge
  // (unusable brief pe fallback HATA DIYA — fail closed).
  const classified = eligible.map((c) => ({ c, ...classify(c) }));
  const counts: Record<CampaignClass, number> = {
    clip_ready: 0,
    join_only: 0,
    needs_phone: 0,
    ugc_unsupported: 0,
  };
  for (const x of classified) counts[x.cls]++;
  const pool = classified.filter((x) => x.cls === "clip_ready").map((x) => x.c);

  if (pool.length === 0) {
    const why = classified
      .filter((x) => x.cls !== "clip_ready")
      .slice(0, 5)
      .map((x) => `${x.c.name ?? x.c.id.slice(0, 8)}: ${x.cls} (${x.reasons.join("; ").slice(0, 80)})`);
    return NextResponse.json({
      ok: false,
      reason: "no_clip_ready",
      detail:
        `Koi clip_ready campaign nahi (eligible ${eligible.length}). ` +
        `Breakdown: ${JSON.stringify(counts)}. ` +
        (why.length > 0 ? `Examples: ${why.join(" | ")}` : ""),
      counts,
    });
  }

  // 5. Payout-weighted random pick (sirf clip_ready me se)
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
  const pickedClass = classify(picked);
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
      classification: pickedClass.cls,
      classification_reasons: pickedClass.reasons,
    },
    pool_size: pool.length,
    with_brief: pool.length,
    counts,
    excluded_submitted: submittedIds.size,
  });
}
