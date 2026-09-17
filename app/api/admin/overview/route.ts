import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin";

/**
 * GET — admin overview across ALL users (service_role).
 * Double-gated by requireAdmin(): owner email + admin password cookie.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00Z`;

  const { data: authUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 100 });
  const users = (authUsers?.users ?? []).map((u) => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
  }));
  const userIds = users.map((u) => u.id);

  const [campaigns, clips, posts, submissions, interventions, connections, activity, postsToday] =
    await Promise.all([
      sb.from("campaigns").select("id, user_id, name, active"),
      sb.from("clips").select("id, user_id, status"),
      sb.from("posts").select("id, user_id, posted_at"),
      sb.from("submissions").select("id, user_id, whop_status, submitted_at"),
      sb.from("interventions").select("id, user_id, kind, status, created_at").order("created_at", { ascending: false }).limit(50),
      sb.from("connections").select("id, user_id, service, status, last_verified"),
      sb.from("activity_log").select("id, user_id, action, created_at").order("created_at", { ascending: false }).limit(30),
      sb.from("posts").select("id").gte("posted_at", dayStart),
    ]);

  const countBy = (rows: { user_id?: string }[] | null) => {
    const m: Record<string, number> = {};
    for (const r of rows ?? []) {
      if (r.user_id) m[r.user_id] = (m[r.user_id] ?? 0) + 1;
    }
    return m;
  };

  const emailOf = (uid: string) => users.find((u) => u.id === uid)?.email ?? uid.slice(0, 8);

  return NextResponse.json({
    date: today,
    totals: {
      users: users.length,
      campaigns: campaigns.data?.length ?? 0,
      clips: clips.data?.length ?? 0,
      posts: posts.data?.length ?? 0,
      postsToday: postsToday.data?.length ?? 0,
      submissions: submissions.data?.length ?? 0,
      pendingInterventions: (interventions.data ?? []).filter((i) => i.status === "pending").length,
      connections: connections.data?.length ?? 0,
    },
    users: users.map((u) => ({
      email: u.email,
      created_at: u.created_at,
      campaigns: countBy(campaigns.data)[u.id] ?? 0,
      clips: countBy(clips.data)[u.id] ?? 0,
      posts: countBy(posts.data)[u.id] ?? 0,
      submissions: countBy(submissions.data)[u.id] ?? 0,
    })),
    pendingInterventions: (interventions.data ?? [])
      .filter((i) => i.status === "pending")
      .map((i) => ({ ...i, email: emailOf(i.user_id) })),
    connections: (connections.data ?? []).map((c) => ({ ...c, email: emailOf(c.user_id) })),
    recentActivity: (activity.data ?? []).map((a) => ({ ...a, email: emailOf(a.user_id) })),
    // keep the id list out of the client payload shape; only used above
    _userIds: userIds.length,
  });
}
