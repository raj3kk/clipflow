/**
 * Automation job creation ka shared helper (cap enforcement ke saath).
 *
 * CAP (user-set 2026-09-18): MAX 4 automations per rolling 24 hours (per user).
 * Cap cross hone pe { capped: true } — phone ko kabhi 5th job milega hi nahi.
 */

export const CAP_COUNT = 4;
export const CAP_WINDOW_HOURS = 24;

/**
 * Jin statuses ke jobs cap me gine jate hain (rolling 24h).
 * 'timeout' = phone ne job uthayi phir marr gaya = failed run, isliye count.
 * 'expired' = phone ne kabhi uthayi hi nahi (48h purani queued) = count NAHI.
 */
export const CAP_JOB_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "timeout",
];

/**
 * Jin statuses me job "zinda" mana jata hai — sirf inhi pe idempotency
 * dedup hota hai. cancelled/failed purana/mara hua job hai: uspe dedup
 * NAHI hota, balki uska key retire karke NAYA job banta hai.
 * (2026-09-19 fix: cancelled job pe deduped:true wala silent failure.)
 */
export const LIVE_JOB_STATUSES = new Set([
  "queued",
  "claimed",
  "dispatched",
  "running",
  "succeeded",
]);

export type JobCreateResult =
  | { ok: true; job_id: string; status: string; deduped?: boolean }
  | { ok: false; code: 404 | 409 | 429 | 500; error: string; cap?: number; window_hours?: number; duplicateCampaign?: boolean };

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
    .select("id, status, deleted_at, disconnected_at")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .single();
  if (!device) {
    return { ok: false, code: 404, error: "Unknown device." };
  }
  // 2026-09-19: soft-deleted ya disconnected device pe naya job NAHI banta.
  if (device.deleted_at) {
    return { ok: false, code: 409, error: "Device deleted." };
  }
  if (device.disconnected_at) {
    return { ok: false, code: 409, error: "Device disconnected." };
  }
  if (device.status !== "active") {
    return {
      ok: false,
      code: 409,
      error: `Device not active (status: ${device.status}).`,
    };
  }

  // Campaign dedup (user demand 2026-09-19): ek Whop account pe same
  // campaign dobara submit NAHI hoga — chahe kitne devices hon.
  // v2_submissions me successful submit ka record hai to naya job mat banao.
  const campaignSlug =
    typeof payload.campaign_slug === "string" && payload.campaign_slug
      ? payload.campaign_slug
      : null;
  if (campaignSlug) {
    const { data: already } = await sb
      .from("v2_submissions")
      .select("id")
      .eq("user_id", userId)
      .eq("campaign_slug", campaignSlug)
      .limit(1);
    if (already && already.length > 0) {
      return {
        ok: false,
        code: 409,
        error:
          "Ye campaign pehle hi submit ho chuka hai — dobara submit nahi hoga.",
        duplicateCampaign: true,
      };
    }

    // LIVE-JOB DEDUP (2026-09-19 fix): same campaign ka job already
    // queued/claimed/dispatched/running ho to naya job mat banao.
    // Bina iske: planner pass-2 (v2_submissions row abhi bani nahi) same
    // campaign ka doosra moment leke doosra job bana deta tha → phone
    // dono post karke Whop pe DOUBLE submit karta tha. Ek live job hi
    // kaafi hai — naya request usi pe dedup hota hai.
    const { data: liveDupe } = await sb
      .from("device_jobs")
      .select("id, status")
      .eq("user_id", userId)
      .in("status", ["queued", "claimed", "dispatched", "running"])
      .eq("payload->>campaign_slug", campaignSlug)
      .order("created_at", { ascending: true })
      .limit(1);
    if (liveDupe && liveDupe.length > 0) {
      return {
        ok: true,
        job_id: (liveDupe[0] as { id: string }).id,
        status: (liveDupe[0] as { status: string }).status,
        deduped: true,
      };
    }
  }

  // Cap: last 24h me live jobs gino
  const since = new Date(
    Date.now() - CAP_WINDOW_HOURS * 3600 * 1000
  ).toISOString();
  const { count, error: countErr } = await sb
    .from("device_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("status", CAP_JOB_STATUSES);
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

  // Insert — idempotency_key duplicate (23505) pe purana job dekho.
  // LIVE job (queued/claimed/dispatched/running/succeeded) → deduped:true.
  // cancelled/failed purana job → uska key retire karke NAYA job banao
  // (nahi to retry hamesha mare hue job ko wapas deta — silent failure).
  for (let attempt = 0; attempt < 2; attempt++) {
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

    if (!jobErr && job) {
      return { ok: true, job_id: job.id, status: "queued" };
    }

    const msg = jobErr?.message ?? "Job create failed.";
    if (jobErr?.code === "23505" && opts?.idempotency_key) {
      const { data: existing } = await sb
        .from("device_jobs")
        .select("id, status")
        .eq("idempotency_key", opts.idempotency_key)
        .eq("user_id", userId)
        .single();
      if (existing && LIVE_JOB_STATUSES.has(existing.status)) {
        return {
          ok: true,
          job_id: existing.id,
          status: existing.status,
          deduped: true,
        };
      }
      if (existing) {
        // Purana job cancelled/failed hai — key retire karo, fresh insert retry.
        await sb
          .from("device_jobs")
          .update({ idempotency_key: null })
          .eq("id", existing.id);
        continue;
      }
    }
    return { ok: false, code: 500, error: msg };
  }
  return { ok: false, code: 500, error: "Job create failed." };
}

/**
 * Best-effort activity_log row (website pe Activity tab me dikhta hai).
 * Kabhi throw nahi karta.
 */
export async function logActivity(
  sb: any,
  userId: string | null,
  event: string,
  text: string
): Promise<void> {
  try {
    await sb.from("activity_log").insert({
      user_id: userId,
      actor: "worker",
      event,
      detail: { text: text.slice(0, 500) },
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Stuck-job reconciliation — server-side, phone-poll se independent.
 *
 * 2026-09-19 se pehle ye logic sirf jobs/next (phone poll) me thi: phone
 * marr jaye to 'running' job hamesha atki rehti thi. Ab schedule-tick
 * (har 15 min) bhi ise chalata hai.
 *
 * 1. dispatched/running + last_heartbeat 45+ min purana → attempts bache hon
 *    to wapas 'queued' (run_after = +60s, turant retry nahi), nahi to terminal
 *    'timeout' (+ activity_log).
 * 2. queued + 48h se zyada purana (phone kabhi online nahi aaya, clip stale)
 *    → 'expired' (+ activity_log). 'expired' cap me NAHI ginta.
 *
 * Returns { requeued, timedOut, expired }.
 */
export const HEARTBEAT_TIMEOUT_MIN = 45;
export const QUEUED_EXPIRY_HOURS = 48;

export async function reconcileStaleJobs(
  sb: any,
  deviceId: string,
  userId: string
): Promise<{ requeued: number; timedOut: number; expired: number }> {
  const out = { requeued: 0, timedOut: 0, expired: 0 };
  const now = new Date();
  const nowIso = now.toISOString();

  // --- 1) heartbeat-timeout: dispatched/running, 45+ min se koi heartbeat nahi
  const staleCutoff = new Date(
    now.getTime() - HEARTBEAT_TIMEOUT_MIN * 60 * 1000
  ).toISOString();
  let stale: Array<{
    id: string;
    attempts: number | null;
    max_attempts: number | null;
  }> = [];
  try {
    // NULL last_heartbeat (column se pehle claim hui purani rows) bhi pakdo —
    // unke liye created_at se age dekho.
    const { data } = await sb
      .from("device_jobs")
      .select("id, attempts, max_attempts, last_heartbeat, created_at")
      .eq("device_id", deviceId)
      .in("status", ["dispatched", "running"])
      .or(
        `last_heartbeat.lt.${staleCutoff},and(last_heartbeat.is.null,created_at.lt.${staleCutoff})`
      );
    stale = (data ?? []) as typeof stale;
  } catch {
    /* fetch fail → is device ka reconcile skip, agla tick retry */
    return out;
  }

  for (const s of stale) {
    try {
      if ((s.attempts ?? 0) < (s.max_attempts ?? 3)) {
        await sb
          .from("device_jobs")
          .update({
            status: "queued",
            run_after: new Date(now.getTime() + 60 * 1000).toISOString(),
          })
          .eq("id", s.id);
        await sb.from("job_runs").insert({
          job_id: s.id,
          device_id: deviceId,
          user_id: userId,
          status: "timeout_requeued",
          result: {
            error: `heartbeat timeout (${HEARTBEAT_TIMEOUT_MIN} min) — wapas queue`,
          },
          finished_at: nowIso,
        });
        out.requeued++;
      } else {
        await sb.from("device_jobs").update({ status: "timeout" }).eq("id", s.id);
        await sb.from("job_runs").insert({
          job_id: s.id,
          device_id: deviceId,
          user_id: userId,
          status: "timeout",
          result: {
            error: "heartbeat timeout — attempts khatam, human review",
          },
          finished_at: nowIso,
        });
        await logActivity(
          sb,
          userId,
          "job_timeout",
          `Job ${s.id.slice(0, 8)}… heartbeat timeout — attempts khatam. ` +
            `Live tab me dekhein; zaroorat ho to Run Now se dobara chalayein.`
        );
        out.timedOut++;
      }
    } catch {
      /* ek job fail → baaki continue */
    }
  }

  // --- 2) queued expiry: 48h se zyada purani queued job (clip stale ho chuka)
  const expiryCutoff = new Date(
    now.getTime() - QUEUED_EXPIRY_HOURS * 3600 * 1000
  ).toISOString();
  let old: Array<{ id: string }> = [];
  try {
    const { data } = await sb
      .from("device_jobs")
      .select("id")
      .eq("device_id", deviceId)
      .eq("status", "queued")
      .lt("created_at", expiryCutoff);
    old = (data ?? []) as typeof old;
  } catch {
    return out;
  }
  for (const o of old) {
    try {
      await sb.from("device_jobs").update({ status: "expired" }).eq("id", o.id);
      await sb.from("job_runs").insert({
        job_id: o.id,
        device_id: deviceId,
        user_id: userId,
        status: "expired",
        result: {
          error: `queued ${QUEUED_EXPIRY_HOURS}h+ purani — phone online nahi aaya, clip stale`,
        },
        finished_at: nowIso,
      });
      await logActivity(
        sb,
        userId,
        "job_expired",
        `Job ${o.id.slice(0, 8)}… ${QUEUED_EXPIRY_HOURS} ghante queued rahi, ` +
          `phone online nahi aaya — expire kar di (cap me nahi gini).`
      );
      out.expired++;
    } catch {
      /* continue */
    }
  }

  return out;
}

/**
 * Schedule JSON validate karo. Do modes (+ enabled flag):
 *   { mode: "interval", interval_hours: 1..48, enabled?: bool, clip?: {...} }
 *   { mode: "times", times: ["HH:MM", ...] (1..8), timezone: "Asia/Calcutta", enabled?: bool, clip?: {...} }
 * enabled=false → schedule band (koi auto job nahi; sirf manual Run Now).
 * clip (optional) = automation ka "clip package":
 *   { video_url, caption, whop_submit_url } — schedule Run Now dono isi se
 *   workflow steps banate hain. Yahan sirf passthrough (validate workflow me).
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
  const enabled = o.enabled === undefined ? true : o.enabled === true;
  // clip package passthrough (shape validateClipPackage me hota hai)
  const clip =
    typeof o.clip === "object" && o.clip !== null
      ? (o.clip as Record<string, unknown>)
      : undefined;
  if (o.mode === "interval") {
    const h = Number(o.interval_hours);
    if (!Number.isInteger(h) || h < 1 || h > 48) {
      return { ok: false, error: "interval_hours must be an integer 1..48." };
    }
    const schedule: Record<string, unknown> = {
      mode: "interval",
      interval_hours: h,
      enabled,
    };
    if (clip) schedule.clip = clip;
    return { ok: true, schedule };
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
    const schedule: Record<string, unknown> = {
      mode: "times",
      times: o.times,
      timezone: tz,
      enabled,
    };
    if (clip) schedule.clip = clip;
    return { ok: true, schedule };
  }
  return { ok: false, error: 'mode must be "interval" or "times".' };
}

export const DEFAULT_SCHEDULE = { mode: "interval", interval_hours: 12, enabled: true };
