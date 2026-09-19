import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * v2 "Live" tab — abhi kya ho raha hai, ek nazar me.
 *
 * GET /api/devices/live  →  {
 *   devices: [...{ id, device_name, platform, app_version, status, paused_until, last_seen, presence }],
 *   active:  [...{ id, device_id, device_name, type, status, attempts, created_at, last_heartbeat }],
 *   recent:  [...{ id, device_id, device_name, status, finished_at, note }]
 * }
 *
 * presence: "online" (last_seen < 5 min) | "idle" | "offline"
 * active: status queued/claimed/running wale jobs
 * recent: aaj ke latest 15 job runs
 */
const ONLINE_MS = 5 * 60 * 1000;

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: devices } = await sb
    .from("devices")
    .select(
      "id, device_name, platform, app_version, status, paused_until, last_seen, created_at, deleted_at, disconnected_at"
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const now = Date.now();
  const devList = (devices ?? []).map((d) => {
    const seen = d.last_seen ? new Date(d.last_seen).getTime() : 0;
    const age = now - seen;
    const presence = !seen ? "offline" : age < ONLINE_MS ? "online" : "idle";
    return {
      ...d,
      status: d.disconnected_at ? "disconnected" : d.status,
      presence,
    };
  });
  const nameById: Record<string, string> = {};
  for (const d of devList) nameById[d.id] = d.device_name;

  const { data: activeJobs } = await sb
    .from("device_jobs")
    .select("id, device_id, type, status, attempts, created_at, last_heartbeat")
    .eq("user_id", user.id)
    .in("status", ["queued", "claimed", "running"])
    .order("created_at", { ascending: false })
    .limit(20);

  const active = (activeJobs ?? []).map((j) => ({
    ...j,
    device_name: nameById[j.device_id] ?? "unknown device",
  }));

  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: runs } = await sb
    .from("job_runs")
    .select("id, job_id, device_id, status, result, finished_at")
    .eq("user_id", user.id)
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(15);

  const recent = (runs ?? []).map((r) => {
    let note = "";
    try {
      const res = (r.result ?? {}) as Record<string, unknown>;
      note = String(res.reason ?? res.note ?? res.error ?? "");
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      job_id: r.job_id,
      device_id: r.device_id,
      device_name: nameById[r.device_id] ?? "unknown device",
      status: r.status,
      finished_at: r.finished_at,
      note: note.slice(0, 140),
    };
  });

  return NextResponse.json({ devices: devList, active, recent });
}
