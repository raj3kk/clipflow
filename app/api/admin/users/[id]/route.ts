import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin";

/**
 * GET — full per-user detail for the admin panel (service_role).
 * Double-gated by requireAdmin(): owner email + admin password cookie.
 * Lets the owner see exactly what one user is doing: campaigns, clips,
 * posts, submissions, connections, interventions, settings, activity.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const userId = params.id;

  const { data: authUser } = await sb.auth.admin.getUserById(userId);

  const [campaigns, clips, posts, submissions, interventions, connections, activity, settings] =
    await Promise.all([
      sb.from("campaigns").select("id, name, sponsor, active, joined, budget_remaining_usd, created_at").eq("user_id", userId).order("created_at", { ascending: false }),
      sb.from("clips").select("id, campaign_id, status, video_url, instagram_url, posted_at, error, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      sb.from("posts").select("id, clip_id, instagram_url, verify_status, posted_at, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      sb.from("submissions").select("id, instagram_url, whop_status, views, earnings_usd, submitted_at").eq("user_id", userId).order("submitted_at", { ascending: false }).limit(50),
      sb.from("interventions").select("id, kind, status, created_at, resolved_at, resolved_via").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
      sb.from("connections").select("service, method, label, status, last_verified").eq("user_id", userId).order("service"),
      sb.from("activity_log").select("actor, event, detail, ts").eq("user_id", userId).order("ts", { ascending: false }).limit(50),
      sb.from("settings").select("*").eq("user_id", userId).single(),
    ]);

  // posts per day for the last 7 days (4/day cap visibility)
  const perDay: Record<string, number> = {};
  for (const p of posts.data ?? []) {
    const day = String(p.posted_at ?? p.created_at ?? "").slice(0, 10);
    if (day) perDay[day] = (perDay[day] ?? 0) + 1;
  }

  return NextResponse.json({
    user: {
      id: userId,
      email: authUser?.user?.email ?? null,
      created_at: authUser?.user?.created_at ?? null,
    },
    settings: settings.data ?? null,
    counts: {
      campaigns: campaigns.data?.length ?? 0,
      clips: clips.data?.length ?? 0,
      posts: posts.data?.length ?? 0,
      submissions: submissions.data?.length ?? 0,
      pendingInterventions: (interventions.data ?? []).filter((i) => i.status === "pending").length,
    },
    postsPerDay: perDay,
    campaigns: campaigns.data ?? [],
    clips: clips.data ?? [],
    posts: posts.data ?? [],
    submissions: submissions.data ?? [],
    interventions: interventions.data ?? [],
    connections: connections.data ?? [],
    activity: activity.data ?? [],
  });
}
