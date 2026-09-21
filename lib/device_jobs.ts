/**
 * CAP (user-set 2026-09-18): MAX 4 automations per rolling 24 hours (per user).
 * Cap cross hone pe { capped: true } — phone ko kabhi 5th job milega hi nahi.
 *
 * 2026-09-19 rule change (user): jo automation 3+ attempts me sahi se
 * complete NA hui (terminal failed, max attempts exhausted, bina proper
 * completion ke fail) wo rolling 24h cap me count NAHI hoti. Sirf genuine
 * attempts (queued/dispatched/running) aur successful completions gine jate
 * hain. Failed run user ki galti nahi hai (app marr gaya / phone online nahi
 * aaya), isliye uska cap slot wapas milta hai.
 *
 * Single source of truth: countCapUsage() + checkCap() — Schedule-tick
 * (app/api/devices/schedule-tick) aur Run Now (plan-job / pipeline_requests
 * → planner_v2 → plan-job) DONO yahi central check use karte hain.
 */

export const CAP_COUNT = 4;
export const CAP_WINDOW_HOURS = 24;

import { sendWakePush } from "@/lib/fcm";

/**
 * Best-effort FCM wake (2026-09-20, work package 3): har fresh job-enqueue
 * ke baad phone ko turant jagao. FCM fail/unconfigured/token-missing →
 * { via: "poll" } — phone agle poll pe job utha lega. Kabhi throw nahi
 * karta, request ko kabhi fail nahi karta. Log via + reason (calling route
 * ise response/diagnostics me dalti hai).
 */
export async function wakeDevice(
  sb: any,
  deviceId: string
): Promise<{ via: "fcm" | "poll"; reason?: string }> {
  try {
    const { data: d } = await sb
      .from("devices")
      .select("fcm_token")
      .eq("id", deviceId)
      .single();
    if (!d?.fcm_token) {
      return {
        via: "poll",
        reason:
          "Phone ne FCM token register nahi kiya (app purana ya Firebase setup baaki).",
      };
    }
    return await sendWakePush(d.fcm_token);
  } catch (e) {
    return {
      via: "poll",
      reason: e instanceof Error ? e.message : "wake failed",
    };
  }
}

/**
 * UNLIMITED MODE (user-ordered 2026-09-21): "sara limitation remove kro from
 * core — 24 hours 4 ya 1 day 4, jitna v limitations h sabko remove kro,
 * unlimited". Isliye 4/24h cap AUR 1-hour success cooldown DONO permanently
 * disabled — ye user ka explicit latest order hai (2026-09-20 wale
 * testing-note ko supersede karta hai).
 *
 * NOTE: Instagram action-block pe 24h auto-pause AB BHI LAGA RAHEGA —
 * wo throughput cap nahi, account-safety hai (user ka standing rule:
 * "action block → stop immediately and notify"). IG khud block kare to
 * hammer karna account ban karwa dega.
 */
export const TESTING_NO_LIMITS = true;

/**
 * Time-bounded cap lift (user-set 2026-09-20 23:05 IST): "Haan, 5-6 chalao —
 * aaj ke liye cap kholo". Jab tak now < CAP_LIFT_UNTIL, 4/24h cap AUR 1-hour
 * success cooldown dono bypass hote hain (sirf is lift window ke liye).
 * Window khatam hote hi cap/cooldown apne aap wapas lag jate hain —
 * TESTING_NO_LIMITS ko haath lagane ki zaroorat nahi.
 */
export const CAP_LIFT_UNTIL = "2026-09-21T18:00:00.000Z";

/** Lift window abhi active hai? */
export function isCapLiftActive(): boolean {
  try {
    return Date.now() < new Date(CAP_LIFT_UNTIL).getTime();
  } catch {
    return false;
  }
}

/**
 * Housekeeping job types — ye "automation run" NAHI hain, isliye inpe na
 * 4/24h cap lagta hai na 1-hour success cooldown. Sirf asli posting
 * automation (type "automation", workflow v2-clip-post) cap/cooldown me
 * ginta hai. (2026-09-20 fix: discover_campaigns ki success khud agle
 * discover ko 1h tak block kar rahi thi — galat tha.)
 */
export const HOUSEKEEPING_JOB_TYPES = new Set([
  "discover_campaigns",
  "verify_campaigns",
  "join_campaign",
]);

/** Ye job type cap/cooldown ke dayre me aata hai? */
export function isCountedAutomationType(type: string | null | undefined) {
  return !!type && !HOUSEKEEPING_JOB_TYPES.has(type);
}

/**
 * Jin statuses ke jobs cap window me dekhe jate hain (rolling 24h).
 * Inme se terminal-failure wale (neeche isTerminalFailure()) cap me
 * count NAHI hote — baaki sab (queued/dispatched/running/succeeded) count.
 * 'timeout' = attempts khatam hone ke baad reconcile ne mara = terminal
 * failure → count NAHI. 'expired' = phone ne kabhi uthayi hi nahi (48h
 * purani queued) = count NAHI.
 */
export const CAP_JOB_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "timeout",
];

/** Ye job terminal failure hai — cap me count NAHI hogi. */
export function isTerminalFailure(j: {
  status?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
}): boolean {
  // 'failed' phone ki report pe hi aata hai (attempts bache hon to result
  // route wapas 'queued' kar deta hai); 'timeout' reconcile sirf
  // attempts>=max_attempts pe karta hai. Dono terminal failure = cap me
  // count NAHI. attempts exhaust hone ke baad bhi jo job abhi
  // dispatched/running hai aur phone uspe kaam kar raha hai, wo GENUINE
  // attempt hai — terminal fail hote hi (failed/timeout) cap se bahar.
  // NOTE: `status` yahan j.status hai — bare `status` DOM global
  // (window.status) ko pakadta hai, Node me ReferenceError deta hai.
  return j.status === "failed" || j.status === "timeout";
}

export type CapUsage = {
  /** Cap me counted automations (rolling 24h, terminal-failure excluded). */
  used: number;
  limit: number;
  window_hours: number;
  remaining: number;
  /**
   * Sabse purani counted automation ka created_at + 24h (ISO). Jab cap full
   * ho to yehi wo waqt hai jab agla slot khulega. null = koi counted run nahi.
   */
  resets_at: string | null;
};

/**
 * Rolling 24h cap usage — user ke device_jobs gino, terminal failures MINUS.
 */
export async function countCapUsage(
  sb: any,
  userId: string
): Promise<CapUsage> {
  const since = new Date(
    Date.now() - CAP_WINDOW_HOURS * 3600 * 1000
  ).toISOString();
  const { data, error } = await sb
    .from("device_jobs")
    .select("id, type, status, attempts, max_attempts, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("status", CAP_JOB_STATUSES);
  if (error) {
    throw new Error(error.message);
  }
  const counted = ((data ?? []) as Array<{
    id: string;
    type?: string | null;
    status: string | null;
    attempts: number | null;
    max_attempts: number | null;
    created_at: string | null;
    // Housekeeping (discover/verify/join) cap me count NAHI hota — sirf
    // asli posting automation ginta hai.
  }>).filter((j) => isCountedAutomationType(j.type) && !isTerminalFailure(j));
  counted.sort(
    (a, b) =>
      new Date(a.created_at ?? 0).getTime() -
      new Date(b.created_at ?? 0).getTime()
  );
  const used = counted.length;
  const resets_at =
    counted.length > 0 && counted[0].created_at
      ? new Date(
          new Date(counted[0].created_at).getTime() +
            CAP_WINDOW_HOURS * 3600 * 1000
        ).toISOString()
      : null;
  return {
    used,
    limit: CAP_COUNT,
    window_hours: CAP_WINDOW_HOURS,
    remaining: Math.max(0, CAP_COUNT - used),
    resets_at,
  };
}

/** Hinglish me "agla slot kab khulega" — cap reject message ke liye. */
function formatResetIST(resets_at: string | null): string {
  if (!resets_at) return "";
  try {
    const s = new Date(resets_at).toLocaleString("en-IN", {
      timeZone: "Asia/Calcutta",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return ` Agla slot ${s} (IST) pe khulega.`;
  } catch {
    return "";
  }
}

export type CapCheck =
  | ({ ok: true } & CapUsage)
  | ({ ok: false; code: 429; error: string } & CapUsage);

/**
 * Central cap gate — createAutomationJob (Schedule + Run Now dono) isi se
 * hota hai. Fail ho chuki (3 attempts) automation isme nahi gini jaati.
 *
 * 2026-09-20 (user demand): 1 SUCCESSFUL automation ke baad agla automation
 * sirf 1 ghante baad — cooldown. 4/24h cap alag se lagta hai.
 */
const SUCCESS_COOLDOWN_MS = 60 * 60 * 1000; // 1 ghanta

export async function checkCap(sb: any, userId: string): Promise<CapCheck> {
  // TESTING MODE (user-set 2026-09-20): testing me koi cap/cooldown nahi.
  // 2026-09-20 agent-system deploy: hard constraint "max 4 posting automation
  // runs / 24h" ke hisab se cap wapas ON — TESTING_NO_LIMITS=false.
  // Testing ke liye ise wapas true karna ho to deliberate change karo.
  if (TESTING_NO_LIMITS || isCapLiftActive()) {
    return {
      ok: true,
      used: 0,
      limit: CAP_COUNT,
      window_hours: CAP_WINDOW_HOURS,
      remaining: CAP_COUNT,
      resets_at: null,
    };
  }
  const usage = await countCapUsage(sb, userId);
  if (usage.used >= usage.limit) {
    return {
      ok: false,
      code: 429,
      ...usage,
      error:
        `Automation cap full ho gaya hai — pichhle 24 ghante me ${usage.used} ` +
        `automation runs ho chuki hain (limit ${usage.limit}).` +
        formatResetIST(usage.resets_at) +
        ` Fail ho chuki automation (3 attempts me complete nahi hui) isme ` +
        `nahi gini jaati — sirf genuine runs ka hisaab hai.`,
    };
  }
  // Success cooldown: pichhla successful POSTING automation 1 ghante ke andar
  // hua to naya automation block — IG action-block se bachne ke liye gap.
  // Sirf type="automation" (v2-clip-post) dekho — discover/verify/join ki
  // success se cooldown trigger NAHI hota.
  try {
    const { data: lastOk } = await sb
      .from("device_jobs")
      .select("last_heartbeat, created_at")
      .eq("user_id", userId)
      .eq("type", "automation")
      .eq("status", "succeeded")
      .order("last_heartbeat", { ascending: false, nullsFirst: false })
      .limit(1);
    const doneAt = lastOk?.[0]
      ? new Date(lastOk[0].last_heartbeat ?? lastOk[0].created_at).getTime()
      : 0;
    const waitMs = SUCCESS_COOLDOWN_MS - (Date.now() - doneAt);
    if (doneAt > 0 && waitMs > 0) {
      const mins = Math.ceil(waitMs / 60000);
      const resumeAt = new Date(doneAt + SUCCESS_COOLDOWN_MS);
      return {
        ok: false,
        code: 429,
        ...usage,
        error:
          `Pichla automation safal hua tha — agla automation ${mins} min baad ` +
          `shuru ho sakta hai (1 ghante ka gap). ` +
          resumeAt.toLocaleString("en-IN", {
            timeZone: "Asia/Calcutta",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }) +
          ` (IST) ke baad dobara try karo.`,
      };
    }
  } catch {
    /* cooldown check fail ho to cap ko block mat karo */
  }
  return { ok: true, ...usage };
}

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
  | {
      ok: true;
      job_id: string;
      status: string;
      deduped?: boolean;
      /**
       * FCM wake ka outcome (sirf fresh insert pe; deduped pe undefined).
       * via:"poll" = phone agle poll pe uthayega — koi failure nahi.
       */
      wake?: { via: "fcm" | "poll"; reason?: string };
    }
  | { ok: false; code: 404 | 409 | 429 | 500; error: string; cap?: number; window_hours?: number; used?: number; resets_at?: string | null; duplicateCampaign?: boolean };

export async function createAutomationJob(
  sb: any,
  userId: string,
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
  opts?: {
    idempotency_key?: string;
    run_after?: string;
    /**
     * Campaign live-dedup kin job types tak seemit rahe. Default (undefined)
     * = sab types (clip flow ka purana behavior — zero change).
     * join_campaign isko ["join_campaign"] deta hai: live CLIP job hone se
     * join job dabna nahi chahiye (warna join kabhi enqueue hi nahi hota).
     */
    campaignDedupTypes?: string[];
  }
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
    // opts.campaignDedupTypes (Round-7): join_campaign sirf apne type me
    // dedup karta hai — live clip job join ko rokegi nahi.
    let liveDupeQuery = sb
      .from("device_jobs")
      .select("id, status")
      .eq("user_id", userId)
      .in("status", ["queued", "claimed", "dispatched", "running"])
      .eq("payload->>campaign_slug", campaignSlug)
      .order("created_at", { ascending: true })
      .limit(1);
    if (opts?.campaignDedupTypes && opts.campaignDedupTypes.length > 0) {
      liveDupeQuery = liveDupeQuery.in("type", opts.campaignDedupTypes);
    }
    const { data: liveDupe } = await liveDupeQuery;
    if (liveDupe && liveDupe.length > 0) {
      return {
        ok: true,
        job_id: (liveDupe[0] as { id: string }).id,
        status: (liveDupe[0] as { status: string }).status,
        deduped: true,
      };
    }
  }

  // Cap: rolling 24h — Schedule-tick, Run Now, sab yahi central checkCap()
  // se hote hain. Terminal-failure (3+ attempts) wali jobs count NAHI hoti.
  // Housekeeping (discover/verify/join) cap-exempt hai — ye posting nahi.
  let cap: CapCheck;
  try {
    cap = isCountedAutomationType(type)
      ? await checkCap(sb, userId)
      : { ok: true, used: 0, limit: CAP_COUNT, window_hours: CAP_WINDOW_HOURS, remaining: CAP_COUNT, resets_at: null };
  } catch (e) {
    return {
      ok: false,
      code: 500,
      error: e instanceof Error ? e.message : "Cap check failed.",
    };
  }
  if (!cap.ok) {
    return {
      ok: false,
      code: 429,
      error: cap.error,
      cap: cap.limit,
      window_hours: cap.window_hours,
      used: cap.used,
      resets_at: cap.resets_at,
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
      // Fresh job queue hua → phone ko turant jagao (best-effort FCM wake).
      // Deduped jobs pe wake nahi — phone pehle se janta hai.
      const wake = await wakeDevice(sb, deviceId);
      return { ok: true, job_id: job.id, status: "queued", wake };
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
 * WebView session health (2026-09-20 WP3): device ne IG/Whop authenticated
 * page kab dekha tha. Freshness window 7 din — usse purana signal =
 * session expire ho sakti hai (phone pe dobara login verify karna padega).
 * Kabhi throw nahi karta; unknown (null signals) = gate nahi lagata
 * (purane apps signals nahi bhejte — unhe punish nahi karenge).
 */
export const SESSION_FRESH_DAYS = 7;

export interface SessionHealth {
  ig_ok_at: string | null;
  whop_ok_at: string | null;
  ig_fresh: boolean;
  whop_fresh: boolean;
  /** dono signals me se koi bhi kabhi nahi aaya */
  unknown: boolean;
}

export async function getSessionHealth(
  sb: any,
  deviceId: string
): Promise<SessionHealth> {
  const empty: SessionHealth = {
    ig_ok_at: null,
    whop_ok_at: null,
    ig_fresh: false,
    whop_fresh: false,
    unknown: true,
  };
  try {
    const { data: d } = await sb
      .from("devices")
      .select("ig_session_ok_at, whop_session_ok_at")
      .eq("id", deviceId)
      .single();
    if (!d) return empty;
    const cutoff = Date.now() - SESSION_FRESH_DAYS * 24 * 3600 * 1000;
    const igAt = (d.ig_session_ok_at as string | null) ?? null;
    const whopAt = (d.whop_session_ok_at as string | null) ?? null;
    const igFresh = !!igAt && new Date(igAt).getTime() > cutoff;
    const whopFresh = !!whopAt && new Date(whopAt).getTime() > cutoff;
    return {
      ig_ok_at: igAt,
      whop_ok_at: whopAt,
      ig_fresh: igFresh,
      whop_fresh: whopFresh,
      unknown: !igAt && !whopAt,
    };
  } catch {
    return empty;
  }
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
 * P0 (2026-09-19): phone app execution ke dauraan heartbeat bhejta hai
 * (Worker D, har ~5 min) — 10 min bina heartbeat = dead.
 * Purane app versions heartbeat NAHI bhejte (sirf claim-time): unke liye
 * 45-min legacy cutoff taaki zinda lambi run beech me wapas queue na ho.
 * Guard: heartbeat_count > 0 = heartbeat-capable app (is job pe kam se kam
 * ek heartbeat aaya); 0 = legacy → last_heartbeat (= claim time) se 45 min.
 *
 * 1. dispatched/running + stale heartbeat → attempts bache hon to wapas
 *    'queued' (run_after = +60s, turant retry nahi), nahi to terminal
 *    'timeout' (+ activity_log).
 * 2. queued + 48h se zyada purana (phone kabhi online nahi aaya, clip stale)
 *    → 'expired' (+ activity_log). 'expired' cap me NAHI ginta.
 *
 * Watchdog: pipeline_watch.py (har 1 min) bhi yehi logic chalata hai —
 * phone marr jaye (poll na aaye) to bhi recovery hoti hai. Yahan wala
 * schedule-tick (15 min) + jobs/next (har poll) se chalta hai.
 *
 * Returns { requeued, timedOut, expired }.
 */
export const HEARTBEAT_TIMEOUT_MIN = 10;
export const LEGACY_HEARTBEAT_TIMEOUT_MIN = 45;
export const QUEUED_EXPIRY_HOURS = 48;

/** Is job ka heartbeat stale hai? (per-job cutoff: heartbeat-capable vs legacy) */
export function isHeartbeatStale(job: {
  heartbeat_count?: number | null;
  last_heartbeat?: string | null;
  created_at?: string | null;
}): boolean {
  const now = Date.now();
  const hbCount = job.heartbeat_count ?? 0;
  const cutoffMin =
    hbCount > 0 ? HEARTBEAT_TIMEOUT_MIN : LEGACY_HEARTBEAT_TIMEOUT_MIN;
  const baseIso = job.last_heartbeat ?? job.created_at;
  if (!baseIso) return false;
  const base = new Date(baseIso).getTime();
  if (!Number.isFinite(base)) return false;
  return now - base > cutoffMin * 60 * 1000;
}

export async function reconcileStaleJobs(
  sb: any,
  deviceId: string,
  userId: string
): Promise<{ requeued: number; timedOut: number; expired: number }> {
  const out = { requeued: 0, timedOut: 0, expired: 0 };
  const now = new Date();
  const nowIso = now.toISOString();

  // --- 1) heartbeat-timeout: dispatched/running, per-job cutoff
  //    (heartbeat_count>0 → 10 min; purana app (0) → claim-time se 45 min)
  let stale: Array<{
    id: string;
    attempts: number | null;
    max_attempts: number | null;
    heartbeat_count: number | null;
    last_heartbeat: string | null;
    created_at: string | null;
  }> = [];
  try {
    const { data } = await sb
      .from("device_jobs")
      .select(
        "id, attempts, max_attempts, heartbeat_count, last_heartbeat, created_at"
      )
      .eq("device_id", deviceId)
      .in("status", ["dispatched", "running"]);
    stale = ((data ?? []) as typeof stale).filter(isHeartbeatStale);
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
