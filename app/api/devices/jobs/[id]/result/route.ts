import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Job ka result: multipart form
 *   meta: JSON { status: succeeded|failed|blocked, vars: {...}, error? }
 *   shot_0..n: PNG screenshots (proof)
 *
 * Screenshots private bucket `device-shots` me jate hain
 * ({userId}/{jobId}/shot_i.png). Screenshot proof ke bina job
 * succeeded nahi hota — phone hamesha bhejta hai (JobEngine).
 *
 * status=blocked → device 24h auto-pause (IG action-block rule).
 */
const BLOCKED_PAUSE_HOURS = 24;

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status, payload, user_id")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  // IDEMPOTENT REPORT (2026-09-19 fix): phone kabhi-kabhi report dobara bhejta
  // hai (timeout-requeue race). Terminal state pe 409 ke bajaye 200 do —
  // taaki phone "report ho gaya" samajhke aage badhe, retry loop me na phase.
  if (["succeeded", "cancelled", "failed", "timeout"].includes(job.status)) {
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      status: job.status,
      duplicate: true,
    });
  }
  // 'queued' bhi accept karo: heartbeat-timeout ne beech me wapas queue kar
  // diya tha, lekin phone ne kaam poora karke report bheji hai.
  if (!["dispatched", "running", "queued"].includes(job.status)) {
    return NextResponse.json(
      { error: `Job already ${job.status}.` },
      { status: 409 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  let meta: { status?: string; vars?: Record<string, string>; error?: string };
  try {
    meta = JSON.parse(String(form.get("meta") ?? "{}"));
  } catch {
    return NextResponse.json({ error: "meta is not valid JSON." }, { status: 400 });
  }
  const status = meta.status ?? "failed";
  if (!["succeeded", "failed", "blocked"].includes(status)) {
    return NextResponse.json({ error: "Bad meta.status." }, { status: 400 });
  }

  // screenshots → private bucket
  const shotPaths: string[] = [];
  let i = 0;
  for (;;) {
    const f = form.get(`shot_${i}`);
    if (!f || typeof f === "string") break;
    const file = f as File;
    const buf = Buffer.from(await file.arrayBuffer());
    const path = `${ident.userId}/${params.id}/shot_${i}.png`;
    const { error: upErr } = await sb.storage
      .from("device-shots")
      .upload(path, buf, { contentType: "image/png", upsert: true });
    if (!upErr) shotPaths.push(path);
    i++;
    if (i > 20) break;
  }

  // LOCKED RULE: screenshot proof ke bina succeeded NAHI.
  // 400 → job state unchanged rehta hai (dispatched/running),
  // taaki phone screenshots ke saath dobara report kar sake.
  if (status === "succeeded" && shotPaths.length === 0) {
    return NextResponse.json(
      { error: "screenshots_required", detail: "succeeded needs >=1 screenshot proof." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  await sb.from("device_jobs").update({ status }).eq("id", job.id);
  await sb.from("job_runs").insert({
    job_id: job.id,
    device_id: ident.deviceId,
    user_id: ident.userId,
    status,
    result: { vars: meta.vars ?? {}, error: meta.error ?? null },
    screenshots: shotPaths,
    finished_at: now,
  });

  const campaignSlug =
    typeof (job.payload as Record<string, unknown> | null)?.campaign_slug ===
    "string"
      ? ((job.payload as Record<string, unknown>).campaign_slug as string)
      : null;

  // SUCCEEDED → v2_submissions me record (campaign dedup ka source of truth).
  // Phir isi campaign ke baaki live jobs cancel — dobara submit nahi hoga.
  if (status === "succeeded" && campaignSlug) {
    await sb.from("v2_submissions").upsert(
      {
        user_id: ident.userId,
        device_id: ident.deviceId,
        job_id: job.id,
        campaign_slug: campaignSlug,
        reel_url: meta.vars?.reel_url ?? null,
        whop_status: "submitted",
        submitted_at: now,
      },
      { onConflict: "user_id,campaign_slug" }
    );
    // Is campaign ke baaki queued/dispatched/running jobs cancel karo.
    // (payload JSON me campaign_slug match — phone dobara submit nahi karega.)
    const { data: dupes } = await sb
      .from("device_jobs")
      .select("id")
      .eq("user_id", ident.userId)
      .in("status", ["queued", "dispatched", "running"])
      .neq("id", job.id);
    for (const d of dupes ?? []) {
      const { data: dj } = await sb
        .from("device_jobs")
        .select("payload")
        .eq("id", (d as { id: string }).id)
        .single();
      const slug = (dj?.payload as Record<string, unknown> | null)
        ?.campaign_slug;
      if (slug === campaignSlug) {
        await sb
          .from("device_jobs")
          .update({ status: "cancelled" })
          .eq("id", (d as { id: string }).id);
        await sb.from("job_runs").insert({
          job_id: (d as { id: string }).id,
          device_id: ident.deviceId,
          user_id: ident.userId,
          status: "cancelled",
          result: {
            error: `duplicate skipped — campaign '${campaignSlug}' pehle hi submit ho chuka hai`,
          },
          finished_at: now,
        });
      }
    }
  }

  // failed (retry bacha hai) → 30 min baad wapas queue.
  // RE-REPORT GUARD: phone ne yehi 'failed' pehle bhi report kiya tha to
  // dobara queue mat karo (nahi to failed↔queued loop chalta rehta hai).
  if (status === "failed") {
    // Abhi insert kiya hua 'failed' run sabse naya hai; usse pehle wala
    // run dekho — agar wo bhi 'failed' tha to ye re-report hai.
    const { data: runs } = await sb
      .from("job_runs")
      .select("status")
      .eq("job_id", job.id)
      .order("finished_at", { ascending: false })
      .limit(2);
    const prevFailed =
      Array.isArray(runs) &&
      runs.length >= 2 &&
      (runs[1] as { status: string }).status === "failed";
    if (!prevFailed) {
      const { data: j } = await sb
        .from("device_jobs")
        .select("attempts, max_attempts")
        .eq("id", job.id)
        .single();
      if (j && j.attempts < j.max_attempts) {
        await sb
          .from("device_jobs")
          .update({
            status: "queued",
            run_after: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          })
          .eq("id", job.id);
      }
    }
  }

  // blocked → device 24h pause
  if (status === "blocked") {
    await sb
      .from("devices")
      .update({
        status: "paused",
        paused_until: new Date(
          Date.now() + BLOCKED_PAUSE_HOURS * 3600 * 1000
        ).toISOString(),
      })
      .eq("id", ident.deviceId);
  }

  await touchDevice(ident.deviceId);
  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status,
    screenshots: shotPaths.length,
  });
}
