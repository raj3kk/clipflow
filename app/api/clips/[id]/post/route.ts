import { NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase, isConfigured } from "@/lib/supabase";

const DEFAULT_TARGET = 4;
const DEFAULT_SPACING_HOURS = 4;

async function getSettings(sb: SupabaseClient) {
  const { data } = await sb
    .from("settings")
    .select("daily_target, spacing_hours")
    .eq("id", 1)
    .maybeSingle();
  return {
    daily_target: data?.daily_target ?? DEFAULT_TARGET,
    spacing_hours: Number(data?.spacing_hours ?? DEFAULT_SPACING_HOURS),
  };
}

/**
 * Compute when a clip should be posted:
 *   scheduled_for = max(now, last_post + spacing_hours),
 *   and no more than daily_target posts scheduled on any single calendar day.
 */
async function computeScheduledFor(
  sb: SupabaseClient,
  settings: { daily_target: number; spacing_hours: number }
): Promise<Date> {
  const spacingMs = settings.spacing_hours * 3600_000;
  const now = new Date();
  let candidate = now;

  const { data: last } = await sb
    .from("posts")
    .select("scheduled_for, posted_at")
    .order("scheduled_for", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const lastTime = last?.scheduled_for ?? last?.posted_at;
  if (lastTime) {
    const earliest = new Date(lastTime).getTime() + spacingMs;
    if (earliest > candidate.getTime()) candidate = new Date(earliest);
  }

  // Enforce the daily cap: if the candidate's day already has daily_target
  // posts scheduled, push to the next day at 00:00 UTC and re-check.
  for (let i = 0; i < 60; i++) {
    const dayStart = new Date(candidate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const { count } = await sb
      .from("posts")
      .select("id", { count: "exact", head: true })
      .gte("scheduled_for", dayStart.toISOString())
      .lt("scheduled_for", dayEnd.toISOString());
    if ((count ?? 0) < settings.daily_target) break;
    candidate = dayEnd;
  }
  return candidate;
}

/**
 * Schedule an approved clip for posting.
 *
 * Runs a brief-compliance precheck (duration within the campaign's min/max,
 * non-empty caption, non-empty hook). On pass, computes scheduled_for from
 * settings (spacing + daily cap), inserts a posts row with posted_at NULL,
 * and marks the clip 'scheduled'. The worker fills instagram_url + posted_at
 * when it actually posts (PATCH /api/posts/[id]).
 *
 * Note: this schedules the post — it does not post to Instagram itself.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const { data: clip, error: fetchError } = await sb
    .from("clips")
    .select("*, campaigns(*)")
    .eq("id", params.id)
    .single();
  if (fetchError || !clip) {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }
  if (clip.status !== "approved") {
    return NextResponse.json(
      {
        blocked: true,
        reason: `Clip must be approved before scheduling (current: ${clip.status}).`,
      },
      { status: 200 }
    );
  }

  // ---- brief-compliance precheck ----
  const duration = Number(clip.end_sec) - Number(clip.start_sec);
  const minSec = Number(clip.campaigns?.min_seconds ?? 15);
  const maxSec = Number(clip.campaigns?.max_seconds ?? 60);
  const checks = {
    duration_ok: duration >= minSec && duration <= maxSec,
    caption_ok: Boolean(clip.caption && clip.caption.trim().length > 0),
    hook_ok: Boolean(clip.hook_text && clip.hook_text.trim().length > 0),
    duration_sec: duration,
    min_seconds: minSec,
    max_seconds: maxSec,
    checked_at: new Date().toISOString(),
  };
  const failures: string[] = [];
  if (!checks.duration_ok)
    failures.push(`duration ${duration}s outside brief range ${minSec}–${maxSec}s`);
  if (!checks.caption_ok) failures.push("caption is empty");
  if (!checks.hook_ok) failures.push("hook is empty");

  await sb.from("clips").update({ brief_check: checks }).eq("id", params.id);

  if (failures.length > 0) {
    return NextResponse.json(
      {
        blocked: true,
        reason: `Brief precheck failed: ${failures.join("; ")}.`,
        brief_check: checks,
      },
      { status: 200 }
    );
  }

  // ---- schedule ----
  const settings = await getSettings(sb);
  const scheduledFor = await computeScheduledFor(sb, settings);

  const { data: post, error: postError } = await sb
    .from("posts")
    .insert({
      clip_id: params.id,
      campaign_id: clip.campaign_id,
      instagram_url: "",
      platform: "instagram",
      scheduled_for: scheduledFor.toISOString(),
      posted_at: null,
      verify_status: "pending",
    })
    .select()
    .single();
  if (postError) {
    return NextResponse.json({ error: postError.message }, { status: 500 });
  }

  const { data: updated, error: clipError } = await sb
    .from("clips")
    .update({ status: "scheduled", scheduled_for: scheduledFor.toISOString() })
    .eq("id", params.id)
    .select()
    .single();
  if (clipError) {
    return NextResponse.json({ error: clipError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    blocked: false,
    brief_check: checks,
    scheduled_for: scheduledFor.toISOString(),
    settings_used: settings,
    post,
    clip: updated,
  });
}
