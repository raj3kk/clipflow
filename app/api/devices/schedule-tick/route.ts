import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob } from "@/lib/device_jobs";
import { validateClipPackage, buildAutomationPayload } from "@/lib/v2_workflow";
import { sendWakePush } from "@/lib/fcm";

/**
 * Schedule ticker — server khud schedule pe automation job banata hai.
 *
 * POST /api/devices/schedule-tick  (x-worker-secret)
 *   → { ticked_at, devices_checked, created, skipped }
 *
 * Har 15 min me cron se hit hota hai. Har active device ke liye:
 *   - schedule.enabled === false → skip (schedule band hai)
 *   - times mode: pichhle 20 min me aaya hua scheduled time → job banao
 *   - interval mode: current epoch-anchored period → job banao (dedupe by key)
 * Idempotency key (`sched:<device>:<slot>`) double-creation rokta hai;
 * cap (4/24h) aur paused-device check createAutomationJob me hota hai.
 * Phone har 15 min poll karke queued job utha leta hai (FCM optional).
 */
const GRACE_MIN = 20;

interface TickDevice {
  id: string;
  user_id: string;
  device_name: string;
  app_version: string | null;
  status: string;
  last_seen: string | null;
  schedule_json: Record<string, unknown> | null;
  fcm_token: string | null;
}

function tzParts(tz: string): { ymd: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    ymd: `${get("year")}${get("month")}${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data: devices } = await sb
    .from("devices")
    .select("id, user_id, device_name, app_version, status, last_seen, schedule_json, fcm_token")
    .eq("status", "active");

  const now = Date.now();
  const created: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const diag: Array<Record<string, unknown>> = [];

  for (const d of (devices ?? []) as TickDevice[]) {
    // Diagnostics: phone kab online aaya, kaunsa app version, kitne queued
    try {
      const { data: q } = await sb
        .from("device_jobs")
        .select("id, created_at")
        .eq("device_id", d.id)
        .eq("status", "queued")
        .order("created_at", { ascending: true });
      const oldest = (q ?? [])[0]?.created_at ?? null;
      diag.push({
        device_id: d.id,
        name: d.device_name,
        app_version: d.app_version,
        last_seen: d.last_seen,
        last_seen_min_ago:
          d.last_seen != null
            ? Math.round((now - new Date(d.last_seen).getTime()) / 60000)
            : null,
        queued: (q ?? []).length,
        oldest_queued_at: oldest,
        oldest_queued_min_ago:
          oldest != null
            ? Math.round((now - new Date(oldest).getTime()) / 60000)
            : null,
      });
    } catch {
      /* diag best-effort */
    }
  }

  for (const d of (devices ?? []) as TickDevice[]) {
    const sched = (d.schedule_json ?? {}) as Record<string, unknown>;
    if (sched.enabled === false) {
      skipped.push({ device_id: d.id, reason: "schedule_disabled" });
      continue;
    }
    const slots: string[] = [];
    if (sched.mode === "times") {
      const times = (sched.times ?? []) as string[];
      const tz =
        typeof sched.timezone === "string" && sched.timezone
          ? sched.timezone
          : "Asia/Calcutta";
      let cur: { ymd: string; minutes: number };
      try {
        cur = tzParts(tz);
      } catch {
        skipped.push({ device_id: d.id, reason: "bad_timezone" });
        continue;
      }
      for (const t of times) {
        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
        if (!m) continue;
        const tMin = Number(m[1]) * 60 + Number(m[2]);
        const diff = cur.minutes - tMin;
        if (diff >= 0 && diff < GRACE_MIN) {
          slots.push(`sched:${d.id}:${cur.ymd}:${m[1]}${m[2]}`);
        }
      }
    } else {
      // interval mode — epoch-anchored periods (deterministic, race-safe)
      const h = Number(sched.interval_hours ?? 12);
      if (!Number.isInteger(h) || h < 1 || h > 48) {
        skipped.push({ device_id: d.id, reason: "bad_interval" });
        continue;
      }
      const period = Math.floor(now / (h * 3600 * 1000));
      slots.push(`sched:${d.id}:int:${period}`);
    }

    if (slots.length === 0) {
      skipped.push({ device_id: d.id, reason: "no_due_slot" });
      continue;
    }

    // Clip package bina automation adhuri hai — pehle website pe set karo
    const clipCheck = validateClipPackage(sched.clip);
    if (!clipCheck.ok || !clipCheck.pkg) {
      skipped.push({
        device_id: d.id,
        reason: "no_clip_package",
        detail:
          "Clip package set nahi hai (video URL + caption + Whop URL). Device card me 'Clip package' bharo.",
      });
      continue;
    }
    const payload = buildAutomationPayload(clipCheck.pkg);

    for (const key of slots) {
      const res = await createAutomationJob(
        sb,
        d.user_id,
        d.id,
        "automation",
        { ...payload, trigger: "schedule", slot: key },
        { idempotency_key: key }
      );
      if (res.ok && !res.deduped) {
        created.push({ device_id: d.id, job_id: res.job_id, slot: key });
        // Best-effort wake push: phone turant jaag jaye. FCM fail ho to bhi
        // job queue me safe hai — phone agle poll pe utha lega. Request kabhi fail nahi hogi.
        if (d.fcm_token) {
          try {
            const w = await sendWakePush(d.fcm_token);
            const entry = created[created.length - 1] as Record<string, unknown>;
            entry.wake = w.via;
            if (!w.sent) entry.wake_reason = w.reason;
          } catch (e) {
            const entry = created[created.length - 1] as Record<string, unknown>;
            entry.wake = "poll";
            entry.wake_reason = e instanceof Error ? e.message : "wake failed";
          }
        }
      } else if (res.ok) {
        skipped.push({ device_id: d.id, reason: "already_queued_for_slot", slot: key });
      } else {
        skipped.push({
          device_id: d.id,
          reason: res.code === 429 ? "cap_reached" : res.code === 409 ? "device_not_active" : "create_failed",
          detail: res.error,
          slot: key,
        });
      }
    }
  }

  return NextResponse.json({
    ticked_at: new Date().toISOString(),
    devices_checked: (devices ?? []).length,
    devices: diag,
    created,
    skipped,
  });
}
