import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

export async function GET() {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ posts: [], configured: false });
  }
  const { data, error } = await sb
    .from("posts")
    .select(
      "*, campaigns(name), submissions(id, clip_id, whop_status, submitted_at, views, earnings_usd, keep_live_until)"
    )
    .order("scheduled_for", { ascending: false, nullsFirst: false })
    .order("posted_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Flatten helpers alongside the raw joins: campaign_name string + single
  // submission object (first linked), for consumers that prefer them.
  const posts = (data ?? []).map((row) => {
    const { campaigns, submissions } = row as unknown as {
      campaigns: { name?: string } | null;
      submissions:
        | {
            id: string;
            whop_status: string | null;
            submitted_at: string | null;
            keep_live_until: string | null;
          }[]
        | null;
    };
    const first = Array.isArray(submissions) ? submissions[0] : null;
    return {
      ...row,
      campaign_name: campaigns?.name ?? null,
      submission: first
        ? {
            id: first.id,
            whop_status: first.whop_status,
            submitted_at: first.submitted_at,
            keep_live_until: first.keep_live_until,
          }
        : null,
    };
  });
  return NextResponse.json({ posts, configured: true });
}

/**
 * Record a post manually. instagram_url is required.
 * If clip_id is given, the clip is marked 'posted'.
 */
export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { instagram_url, posted_at, clip_id, campaign_id, platform } = body;
  if (!instagram_url) {
    return NextResponse.json(
      { error: "instagram_url is required." },
      { status: 400 }
    );
  }
  const postedAt = posted_at ?? new Date().toISOString();
  const { data, error } = await sb
    .from("posts")
    .insert({
      clip_id: clip_id ?? null,
      campaign_id: campaign_id ?? null,
      instagram_url,
      platform: platform ?? "instagram",
      posted_at: postedAt,
      verify_status: "pending",
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (clip_id) {
    await sb
      .from("clips")
      .update({ status: "posted", instagram_url, posted_at: postedAt })
      .eq("id", clip_id);
  }
  return NextResponse.json({ post: data }, { status: 201 });
}
