import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import {
  resolveCampaignAsset,
  resolveCampaignAssetDeep,
  type AssetResolution,
} from "@/lib/agent/asset_resolver";
import {
  extractRequirements,
  type ExtractedRequirements,
} from "@/lib/agent/requirement_extractor";

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

/** @deprecated WP3: asset_resolver.resolveCampaignAsset use karo (brief_url ka
 *  hona kaafi nahi — quarantine + kind checks zaroori hain). */
function hasUsableBrief(c: Campaign): boolean {
  const url = verifiedVideoUrl(c) || (c.brief_url || "").trim();
  return url.length > 0;
}

/**
 * Campaign classification (2026-09-20 compliance hardening; 2026-09-20 WP3:
 * asset resolution + requirement extraction integrated):
 * - clip_ready:    clip ban sakta hai — pick pool me jayega. Asset RESOLVED
 *                  hona chahiye (asset_resolver) — sirf brief_url ka hona
 *                  kaafi nahi. Caption absent ho to extractor compliant
 *                  caption generate karta hai (generated:true) — needs_phone
 *                  nahi jata.
 * - join_only:     join kar sakte hain, clip ke liye asset resolve nahi hua
 * - needs_phone:   user ka action chahiye (payment decision / bio link /
 *                  hard required moment jo resolve nahi hua)
 * - ugc_unsupported: original UGC (face-cam/talking-head) mangta hai —
 *                  automation se banaya hua clip compliant nahi hoga
 */
type CampaignClass = "clip_ready" | "join_only" | "needs_phone" | "ugc_unsupported";

function classify(c: Campaign): {
  cls: CampaignClass;
  reasons: string[];
  asset: AssetResolution;
  extracted: ExtractedRequirements;
} {
  const n = (c.notes || {}) as Record<string, unknown>;
  const req = (c.requirements || "").toLowerCase();
  const nameL = (c.name || "").toLowerCase();
  const asset = resolveCampaignAsset(c);
  const extracted = extractRequirements(c);

  // 1. Payment-looking join → user decide karega (auto-buy KABHI nahi)
  if (
    n.join_paid === true ||
    /\$\s*\d+\s*(\/\s*(mo|month)|per\s*month)|\/mo\b|paid membership|subscription required/i.test(
      req + " " + nameL
    )
  ) {
    return { cls: "needs_phone", reasons: ["payment-looking join — user decide karega"], asset, extracted };
  }

  // 2. Original UGC (face-cam / talking-head / khud record karo) → automation se nahi
  if (
    /original\s+(video|content)|film\s+yourself|record\s+yourself|face[\s-]?cam|talking[\s-]?head/i.test(
      req
    )
  ) {
    return { cls: "ugc_unsupported", reasons: ["original UGC required — automation compliant nahi"], asset, extracted };
  }

  // 3. Required bio link set nahi → user ka kaam (IG app me manual)
  const bioLink = (extracted.required_bio_link.value || (n.required_bio_link as string | undefined) || "").trim();
  const bioSet = n.bio_link_set === true;
  if (bioLink && !bioSet) {
    return {
      cls: "needs_phone",
      reasons: [`required bio link set nahi: ${bioLink.slice(0, 60)}`],
      asset,
      extracted,
    };
  }

  // 3b. Hard required footage/moment unresolved → KABHI invent mat karo
  if (extracted.hard_blocked) {
    return {
      cls: "needs_phone",
      reasons: extracted.hard_block_reasons.slice(0, 3),
      asset,
      extracted,
    };
  }

  // 4. Bina RESOLVED asset ke clip nahi ban sakta → join_only.
  // (WP3: sirf brief_url ka hona kaafi nahi — quarantined patched YouTube
  // URLs aur Google-Doc-bina-footage yahan filter hote hain.)
  if (!asset.eligible) {
    return {
      cls: "join_only",
      reasons: asset.quarantined
        ? ["asset quarantined hai — authorization baaki", ...asset.reasons.slice(0, 2)]
        : [`koi resolved video asset nahi (${asset.reasons.slice(-1)[0] || "unknown"})`],
      asset,
      extracted,
    };
  }

  // 5. Caption: exact/normalized nahi → extractor generate karta hai
  // (generated:true). Galat-caption reject risk ab managed hai — needs_phone nahi.
  const reasons: string[] = [];
  if (extracted.caption_template.generated) {
    reasons.push(`caption generated (brief me exact nahi tha): ${extracted.caption_template.source}`);
  }
  if (extracted.hashtags.generated) {
    reasons.push("hashtags generated (brief me nahi the)");
  }
  return { cls: "clip_ready", reasons, asset, extracted };
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  let body: { user_id?: string; deep_lookup?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const userId = (body.user_id || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }
  // deep_lookup=true → pool khaali ho to influencer public lookup (bina
  // login) se asset resolve karne ki koshish (max 3 candidates, timeouts ke
  // saath). Planner isey true bhejta hai.
  const deepLookup = body.deep_lookup === true;

  // 1. Active campaigns (MAIN_HUB pool)
  // 2026-09-21: protected campaigns kabhi pool me nahi aate —
  // Charlie Berens (duplicate cancelled, do not revive),
  // Social Commerce News (never revive/duplicate),
  // FundingPips (safety-held: bio-link + requirements not normalized).
  const PROTECTED_IDS = ["hub-9e87c2c6", "hub-1411db9c", "cr-c0c37381"];
  const { data: campaigns, error: campErr } = await sb
    .from("campaigns")
    .select(
      "id,name,sponsor,payout_per_1k_usd,budget_remaining_usd," +
      "min_seconds,max_seconds,requirements,caption_template," +
      "hashtags,brief_url,campaign_url,joined,join_status,notes"
    )
    .eq("user_id", MAIN_HUB_USER_ID)
    .eq("active", true)
    .not("id", "in", `(${PROTECTED_IDS.join(",")})`)
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
  let pool = classified.filter((x) => x.cls === "clip_ready");

  // 4b. Deep lookup fallback (WP3): pool khaali aur deep_lookup=true →
  // sirf-asset-kami wale join_only candidates pe influencer public lookup
  // (max 8, parallel, timeout-guarded). Resolve ho to clip_ready me promote.
  // 2026-09-21: 3→8 — brand-naam wale campaigns ka channel naam se nahi
  // milta; brief-doc @handles se milta hai (asset_resolver).
  let deepPromoted = 0;
  // 2026-09-21: fail-closed diagnostics — har deep-lookup candidate ka
  // outcome (handles tried, resolver reasons, rejected/timeout errors)
  // failure response me bhi expose hota hai taaki pata chale kyun koi
  // candidate resolve nahi hua. Secret/raw brief content kabhi nahi.
  interface DeepDiag {
    id: string;
    name: string | null;
    brief_url: string | null;
    tried_handles: string[];
    outcome: "promoted" | "ineligible" | "rejected";
    detail: string;
  }
  const deepDiags: DeepDiag[] = [];
  if (pool.length === 0 && deepLookup) {
    const assetOnly = classified.filter(
      (x) =>
        x.cls === "join_only" &&
        !x.asset.quarantined &&
        x.reasons.some((r) => /resolved video asset/i.test(r))
    ).slice(0, 8);
    // Parallel — sabse tez successful lookup jeet-ta hai; lookup fail =
    // candidate skip (fail closed), koi exception route ko nahi todta.
    const settled = await Promise.allSettled(
      assetOnly.map((x) => resolveCampaignAssetDeep(x.c, 8000))
    );
    for (let i = 0; i < assetOnly.length; i++) {
      const x = assetOnly[i];
      const s = settled[i];
      const diag: DeepDiag = {
        id: x.c.id,
        name: x.c.name,
        brief_url: (x.c.brief_url || "").trim().slice(0, 140) || null,
        tried_handles: [],
        outcome: "ineligible",
        detail: "",
      };
      if (s.status === "rejected") {
        // Timeout / fetch crash — fail closed, candidate skip.
        const err = s.reason;
        diag.outcome = "rejected";
        diag.detail = String(
          (err && (err as Error).message) || err || "unknown error"
        ).slice(0, 160);
      } else {
        const deep = s.value;
        diag.tried_handles = deep.deepHandles ?? [];
        if (deep.eligible && !deep.quarantined) {
          x.asset = deep;
          x.cls = "clip_ready";
          x.reasons = [...x.reasons, `deep lookup resolved: ${deep.assetUrl}`];
          pool.push(x);
          counts.clip_ready++;
          counts.join_only--;
          deepPromoted++;
          diag.outcome = "promoted";
          diag.detail = `resolved: ${(deep.assetUrl || "").slice(0, 120)}`;
        } else {
          diag.outcome = "ineligible";
          diag.detail = deep.reasons.slice(-2).join(" | ").slice(0, 220);
        }
      }
      deepDiags.push(diag);
    }
  }

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
        (deepLookup
          ? `Deep lookup: ${deepDiags.length} candidate(s) tried, ${deepPromoted} promoted. `
          : "") +
        (why.length > 0 ? `Examples: ${why.join(" | ")}` : ""),
      counts,
      deep_lookup: deepLookup,
      deep_promoted: deepPromoted,
      deep_diagnostics: deepDiags,
    });
  }

  // 5. Payout-weighted random pick (sirf clip_ready me se)
  let totalWeight = 0;
  const weights = pool.map((x) => {
    const w = Math.max(0.1, Number(x.c.payout_per_1k_usd) || 0.1);
    totalWeight += w;
    return w;
  });
  let roll = Math.random() * totalWeight;
  let pickedX = pool[0];
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      pickedX = pool[i];
      break;
    }
  }
  const picked = pickedX.c;

  // 6. Normalized campaign — asset resolution + extracted requirements ke
  // saath (planner/VM inhe notes me merge karta hai; full notes overwrite nahi).
  // brief_url: resolved assetUrl pehle (verified > brief > scraped > lookup),
  // phir legacy fallback.
  const notes = (picked.notes || {}) as Record<string, unknown>;
  const assetUrl = pickedX.asset.assetUrl;
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
      brief_url: assetUrl || verifiedVideoUrl(picked) || picked.brief_url,
      campaign_url: picked.campaign_url,
      joined: picked.joined,
      join_status: picked.join_status,
      notes_eligible: notes.eligible !== false,
      has_brief: pickedX.asset.eligible,
      classification: pickedX.cls,
      classification_reasons: pickedX.reasons,
      asset: pickedX.asset,
      extracted: pickedX.extracted,
      deep_promoted: deepPromoted > 0,
    },
    pool_size: pool.length,
    with_brief: pool.length,
    counts,
    excluded_submitted: submittedIds.size,
    deep_promoted: deepPromoted,
  });
}
