/**
 * Automation job creation ka shared helper (cap enforcement ke saath).
 *
 * CAP (user-set 2026-09-18): MAX 4 automations per rolling 48 hours (per user).
 * Cap cross hone pe { capped: true } — phone ko kabhi 5th job milega hi nahi.
 */

export const CAP_COUNT = 4;
export const CAP_WINDOW_HOURS = 48;

export type JobCreateResult =
  | { ok: true; job_id: string; status: string; deduped?: boolean }
  | { ok: false; code: 404 | 409 | 429 | 500; error: string; cap?: number; window_hours?: number };

export async function createAutomationJob(
  sb: any,
  userId: string,
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
  opts?: { idempotency_key?: string; run_after?: string }
): Promise<JobCreateResult> {
  const { data: device } = await sb
    .from("devices")
    .select("id, status")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .single();
  if (!device) {
    return { ok: false, code: 404, error: "Unknown device." };
  }
  if (device.status !== "active") {
    return {
      ok: false,
      code: 409,
      error: `Device not active (status: ${device.status}).`,
    };
  }

  // Cap: last 48h me live jobs gino
  const since = new Date(
    Date.now() - CAP_WINDOW_HOURS * 3600 * 1000
  ).toISOString();
  const { count, error: countErr } = await sb
    .from("device_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("status", ["queued", "dispatched", "running", "succeeded"]);
  if (countErr) {
    return { ok: false, code: 500, error: countErr.message };
  }
  if ((count ?? 0) >= CAP_COUNT) {
    return {
      ok: false,
      code: 429,
      error: `Automation cap reached: max ${CAP_COUNT} per ${CAP_WINDOW_HOURS}h.`,
      cap: CAP_COUNT,
      window_hours: CAP_WINDOW_HOURS,
    };
  }

  const { data: job, error: jobErr } = await sb
    .from("device_jobs")
    .insert({
      user_id: userId,
      device_id: deviceId,
      type,
      payload,
      idempotency_key: opts?.idempotency_key ?? null,
      run_after: opts?.run_after ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    const msg = jobErr?.message ?? "Job create failed.";
    // idempotency_key duplicate → pehle wala job wapas do
    if (jobErr?.code === "23505" && opts?.idempotency_key) {
      const { data: existing } = await sb
        .from("device_jobs")
        .select("id, status")
        .eq("idempotency_key", opts.idempotency_key)
        .eq("user_id", userId)
        .single();
      if (existing) {
        return { ok: true, job_id: existing.id, status: existing.status, deduped: true };
      }
    }
    return { ok: false, code: 500, error: msg };
  }

  return { ok: true, job_id: job.id, status: "queued" };
}

/**
 * Schedule JSON validate karo. Do modes:
 *   { mode: "interval", interval_hours: 1..48 }
 *   { mode: "times", times: ["HH:MM", ...] (1..8), timezone: "Asia/Calcutta" }
 */
export function validateSchedule(s: unknown): {
  ok: boolean;
  error?: string;
  schedule?: Record<string, unknown>;
} {
  if (typeof s !== "object" || s === null) {
    return { ok: false, error: "schedule must be an object." };
  }
  const o = s as Record<string, unknown>;
  if (o.mode === "interval") {
    const h = Number(o.interval_hours);
    if (!Number.isInteger(h) || h < 1 || h > 48) {
      return { ok: false, error: "interval_hours must be an integer 1..48." };
    }
    return { ok: true, schedule: { mode: "interval", interval_hours: h } };
  }
  if (o.mode === "times") {
    if (!Array.isArray(o.times) || o.times.length < 1 || o.times.length > 8) {
      return { ok: false, error: "times must be 1..8 entries." };
    }
    for (const t of o.times) {
      if (typeof t !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        return { ok: false, error: `bad time entry: ${t} (HH:MM 24h).` };
      }
    }
    const tz = typeof o.timezone === "string" && o.timezone ? o.timezone : "Asia/Calcutta";
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      return { ok: false, error: `bad timezone: ${tz}.` };
    }
    return { ok: true, schedule: { mode: "times", times: o.times, timezone: tz } };
  }
  return { ok: false, error: 'mode must be "interval" or "times".' };
}

export const DEFAULT_SCHEDULE = { mode: "interval", interval_hours: 12 };
