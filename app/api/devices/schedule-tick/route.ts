import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob } from "@/lib/device_jobs";

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
  schedule_json: Record<string, unknown> | null;
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
    .select("id, user_id, schedule_json")
    .eq("status", "active");

  const now = Date.now();
  const created: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];

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

    for (const key of slots) {
      const res = await createAutomationJob(
        sb,
        d.user_id,
        d.id,
        "automation",
        { trigger: "schedule", slot: key },
        { idempotency_key: key }
      );
      if (res.ok && !res.deduped) {
        created.push({ device_id: d.id, job_id: res.job_id, slot: key });
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
    created,
    skipped,
  });
}
