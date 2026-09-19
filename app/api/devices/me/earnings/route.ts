import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * PhoneAgent ka Earn tab: device ke user ki v2 (phone) submissions.
 *
 * GET /api/devices/me/earnings  (X-Device-Id + X-Device-Key headers)
 *   Auth: getDeviceIdentity — device ka userId nikalta hai, aur sirf usi
 *   user ki v2_submissions rows aati hain (device key ownership ka proof hai).
 *
 * views / estimated_earnings_usd: v2_submissions table me ye columns NAHI
 * hain — isliye hamesha null bheja jata hai. KABHI fake/random number nahi.
 */
export async function GET(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: subs, error } = await sb
    .from("v2_submissions")
    .select("id, campaign_slug, reel_url, whop_status, submitted_at")
    .eq("user_id", ident.userId)
    .order("submitted_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // campaign_name best-effort: campaigns.id == campaign_slug (user-scoped).
  const slugs = Array.from(
    new Set(
      (subs ?? [])
        .map((s) => s.campaign_slug)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );
  const nameById: Record<string, string> = {};
  if (slugs.length > 0) {
    const { data: camps } = await sb
      .from("campaigns")
      .select("id, name")
      .eq("user_id", ident.userId)
      .in("id", slugs);
    for (const c of camps ?? []) nameById[c.id] = c.name;
  }

  const submissions = (subs ?? []).map((s) => ({
    id: s.id,
    campaign_slug: s.campaign_slug,
    campaign_name:
      typeof s.campaign_slug === "string" && s.campaign_slug
        ? (nameById[s.campaign_slug] ?? null)
        : null,
    reel_url: s.reel_url,
    whop_status: s.whop_status,
    submitted_at: s.submitted_at,
    views: null as number | null,
    estimated_earnings_usd: null as number | null,
  }));

  return NextResponse.json({
    ok: true,
    submissions,
    totals: {
      total_submissions: submissions.length,
      total_views: null,
      total_estimated_earnings_usd: null,
    },
  });
}
