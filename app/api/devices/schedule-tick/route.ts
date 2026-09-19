import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import {
  createAutomationJob,
  reconcileStaleJobs,
} from "@/lib/device_jobs";
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
 *   - times mode: pichhle 45 min me aaya hua scheduled time → job banao
 *     (grace 20→45 min: 2-3 missed tick bhi catchup ho jate hain; idempotency
 *     key repeat-creation rokta hai)
 *   - interval mode: current epoch-anchored period + previous period → job
 *     banao (dedupe by key; pichhla period miss hua ho to catchup)
 * Manual clip package set ho → direct automation job (testing ke liye).
 * Manual clip NA ho → pipeline_requests row banti hai; watcher (1-min cron)
 * planner chalata hai jo campaign se clip bana ke plan-job enqueue karta hai.
 * User ko kuch bharna nahi padta (zero-touch, 2026-09-19).
 * Idempotency key (`sched:<device>:<slot>`) double-creation rokta hai;
 * cap (4/24h) aur paused-device check createAutomationJob me hota hai.
 * Phone har 15 min poll karke queued job utha leta hai (FCM optional).
 *
 * 2026-09-19 (round-6): har tick pe reconcileStaleJobs bhi chalta hai —
 * heartbeat-timeout (45 min) + 48h-purani queued expiry, phone-poll se
 * independent. Phone marr jaye to bhi stuck jobs recover hote hain.
 */
const GRACE_MIN = 45;

interface TickDevice {
  id: string;
  user_id: string;
  device_name: string;
  app_version: string | null;
  status: string;
  last_seen: string | null;
  created_at: string | null;
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
    .select("id, user_id, device_name, app_version, status, last_seen, created_at, schedule_json, fcm_token")
    .eq("status", "active")
    .is("deleted_at", null)
    .is("disconnected_at", null);

  const now = Date.now();
  const created: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const diag: Array<Record<string, unknown>> = [];
  const reconciled: Array<Record<string, unknown>> = [];

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
    // Stuck-job recovery (server-side, phone-poll se independent):
    // 45-min heartbeat-timeout + 48h-purani queued expiry.
    try {
      const r = await reconcileStaleJobs(sb, d.id, d.user_id);
      if (r.requeued + r.timedOut + r.expired > 0) {
        reconciled.push({ device_id: d.id, ...r });
      }
    } catch {
      /* best-effort — tick aage badhegi */
    }

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
      // interval mode — epoch-anchored periods (deterministic, race-safe).
      // Catchup: current period ke saath PREVIOUS period bhi try karo —
      // tick kuch ghante down raha ho aur period boundary cross ho gayi ho
      // to wo slot miss nahi hoga. Idempotency key repeat-creation rokta hai.
      const h = Number(sched.interval_hours ?? 12);
      if (!Number.isInteger(h) || h < 1 || h > 48) {
        skipped.push({ device_id: d.id, reason: "bad_interval" });
        continue;
      }
      const period = Math.floor(now / (h * 3600 * 1000));
      slots.push(`sched:${d.id}:int:${period}`);
      // Catchup: pichhle period ka slot bhi try karo (missed tick recovery).
      // Device us period se PEHLE se enrolled hona chahiye — naya device
      // enroll hote hi purane period ka backfill NAHI hona chahiye.
      const prevPeriodStart = (period - 1) * h * 3600 * 1000;
      const devCreated = d.created_at
        ? new Date(d.created_at).getTime()
        : 0;
      if (devCreated && devCreated < prevPeriodStart) {
        slots.push(`sched:${d.id}:int:${period - 1}`);
      }
    }

    if (slots.length === 0) {
      skipped.push({ device_id: d.id, reason: "no_due_slot" });
      continue;
    }

    // Manual clip set nahi hai → pipeline khud clip banayegi.
    // pipeline_requests row banao taaki watcher (1-min cron) planner chala de.
    // Manual clip set ho → purana direct-job behavior (testing ke liye).
    // User ko kuch bharna NAHI padta — ye 2026-09-19 ka zero-touch fix hai.
    const clipCheck = validateClipPackage(sched.clip);
    if (!clipCheck.ok || !clipCheck.pkg) {
      const { data: existingPipe } = await sb
        .from("pipeline_requests")
        .select("id")
        .eq("device_id", d.id)
        .in("status", ["pending", "running"])
        .limit(1);
      if (existingPipe && existingPipe.length > 0) {
        skipped.push({
          device_id: d.id,
          reason: "pipeline_already_pending",
          slots,
        });
        continue;
      }
      const { data: pipeReq, error: pipeErr } = await sb
        .from("pipeline_requests")
        .insert({
          user_id: d.user_id,
          device_id: d.id,
          status: "pending",
          note: `schedule slot (${slots.join(", ")}) — pipeline khud clip banayegi`,
        })
        .select("id")
        .single();
      if (pipeErr || !pipeReq) {
        skipped.push({
          device_id: d.id,
          reason: "pipeline_request_failed",
          detail: pipeErr?.message ?? "insert failed",
          slots,
        });
      } else {
        created.push({
          device_id: d.id,
          pipeline_request_id: pipeReq.id,
          slots,
          via: "pipeline",
        });
      }
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

  // 2026-09-19: 7+ din purani soft-deleted devices ka auto hard-delete.
  // FK cascade se device_jobs + job_runs apne aap delete hote hain;
  // screenshots (device-shots bucket) best-effort saaf hote hain.
  let hardDeleted = 0;
  try {
    const cutoff = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: old } = await sb
      .from("devices")
      .select("id")
      .lt("deleted_at", cutoff);
    for (const d of old ?? []) {
      try {
        const { data: files } = await sb.storage
          .from("device-shots")
          .list(d.id, { limit: 1000 });
        const paths = (files ?? [])
          .filter((f) => f.name)
          .map((f) => `${d.id}/${f.name}`);
        if (paths.length > 0) {
          await sb.storage.from("device-shots").remove(paths);
        }
      } catch {
        /* best-effort */
      }
      const { error: delErr } = await sb
        .from("devices")
        .delete()
        .eq("id", d.id);
      if (!delErr) hardDeleted++;
    }
  } catch {
    /* cleanup best-effort — tick kabhi fail nahi hogi */
  }

  return NextResponse.json({
    ticked_at: new Date().toISOString(),
    devices_checked: (devices ?? []).length,
    devices: diag,
    reconciled,
    created,
    skipped,
    cleanup: { hard_deleted: hardDeleted },
  });
}
