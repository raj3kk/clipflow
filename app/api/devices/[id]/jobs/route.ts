import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Device ke recent jobs + latest run + screenshot signed URLs (dashboard).
 * Saath me cap meter: last 24h me kitne automations hue (max 4).
 *
 * GET /api/devices/:id/jobs  →  { device, jobs, cap_used, cap_max }
 */
const CAP_COUNT = 4;
const CAP_WINDOW_HOURS = 24;

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
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

  const { data: device } = await sb
    .from("devices")
    .select(
      "id, device_name, platform, app_version, status, paused_until, last_seen, created_at"
    )
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const { data: jobs } = await sb
    .from("device_jobs")
    .select("id, type, status, attempts, created_at")
    .eq("device_id", params.id)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(20);

  const jobIds = (jobs ?? []).map((j) => j.id);
  let runsByJob: Record<string, Record<string, unknown>> = {};
  if (jobIds.length > 0) {
    const { data: runs } = await sb
      .from("job_runs")
      .select("job_id, status, result, screenshots, finished_at")
      .in("job_id", jobIds)
      .order("finished_at", { ascending: false });
    // latest run per job + signed screenshot URLs (max 6 per job)
    for (const r of runs ?? []) {
      if (runsByJob[r.job_id]) continue;
      const shots: string[] = [];
      for (const p of (r.screenshots ?? []).slice(0, 6)) {
        const { data: signed } = await sb.storage
          .from("device-shots")
          .createSignedUrl(p, 3600);
        if (signed?.signedUrl) shots.push(signed.signedUrl);
      }
      runsByJob[r.job_id] = { ...r, shot_urls: shots };
    }
  }

  const since = new Date(
    Date.now() - CAP_WINDOW_HOURS * 3600 * 1000
  ).toISOString();
  // Cap meter — enforcement (lib/device_jobs.ts CAP_JOB_STATUSES) ke barabar:
  // 'timeout' bhi ginta hai (phone ne uthaya phir marr gaya = ek run).
  // 2026-09-19 fix: pehle 'timeout' chhoota hua tha → meter kam dikhata tha.
  const { count: capUsed } = await sb
    .from("device_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", since)
    .in("status", ["queued", "dispatched", "running", "succeeded", "failed", "timeout"]);

  return NextResponse.json({
    device,
    jobs: (jobs ?? []).map((j) => ({ ...j, run: runsByJob[j.id] ?? null })),
    cap_used: capUsed ?? 0,
    cap_max: CAP_COUNT,
    cap_window_hours: CAP_WINDOW_HOURS,
  });
}
