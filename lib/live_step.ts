import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-driven live step queue — website → device direction.
 *
 * Storage: `device_jobs.payload.pending_step` — KOI NAYI COLUMN NAHI.
 * payload job creation pe write-once hai; heartbeat / shot / result routes
 * use chhute bhi nahi (wo sirf live_steps / live_frame / current_step /
 * status likhte hain). Isliye pending_step ke liye ye sabse saaf ghar hai —
 * observability columns (live_steps/live_frame) se takraav nahi.
 *
 * Flow:
 *   website (session user) → POST /api/devices/:id/live/inject {job_id, step}
 *                            ya {job_id, stop:true}
 *   device  (X-Device-Id/Key) → GET /api/devices/:id/live/step?job_id=
 *                            → {ok:true, step:{...}} / {ok:true, stop:true}
 *                              (ek baar dekar turant clear — single delivery)
 *                            → {ok:true}  (koi pending step nahi)
 *
 * pending_step shape: { id, kind: "step"|"stop", step?, injected_at,
 *                        injected_by }
 * step max ~4KB JSON (sanitized). Clear id-matched hai: inject aur
 * device-poll ke beech race me naya step clobber nahi hota.
 */

export const PENDING_STEP_KEY = "pending_step";
const MAX_STEP_JSON = 4096;

/** Jin statuses me job "zinda" hai — sirf inhi pe step inject hota hai. */
export const INJECTABLE_STATUSES = new Set([
  "queued",
  "claimed",
  "dispatched",
  "running",
]);

export interface PendingStep {
  id: string;
  kind: "step" | "stop";
  step?: unknown;
  injected_at: string;
  injected_by: string;
}

export type Sb = SupabaseClient;

function readPending(payload: unknown): PendingStep | null {
  if (!payload || typeof payload !== "object") return null;
  const p = (payload as Record<string, unknown>)[PENDING_STEP_KEY];
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (o.kind !== "step" && o.kind !== "stop") return null;
  if (typeof o.id !== "string" || !o.id) return null;
  return {
    id: o.id,
    kind: o.kind,
    step: o.kind === "step" ? o.step : undefined,
    injected_at: typeof o.injected_at === "string" ? o.injected_at : "",
    injected_by: typeof o.injected_by === "string" ? o.injected_by : "",
  };
}

function withoutPending(payload: unknown): Record<string, unknown> {
  const base =
    payload && typeof payload === "object"
      ? { ...(payload as Record<string, unknown>) }
      : {};
  delete base[PENDING_STEP_KEY];
  return base;
}

/**
 * Website se step inject karo. Ownership check caller karega
 * (device.user_id == session user, job.device_id == device).
 */
export async function injectPendingStep(
  sb: Sb,
  opts: {
    jobId: string;
    deviceId: string;
    userId: string;
    step?: unknown;
    stop?: boolean;
    injectedBy: string;
  }
): Promise<{ ok: true; step_id: string } | { ok: false; code: number; error: string }> {
  const { data: job, error } = await sb
    .from("device_jobs")
    .select("id, status, payload")
    .eq("id", opts.jobId)
    .eq("device_id", opts.deviceId)
    .eq("user_id", opts.userId)
    .maybeSingle();
  if (error || !job) {
    return { ok: false, code: 404, error: "Unknown job." };
  }
  if (!INJECTABLE_STATUSES.has(String(job.status))) {
    return {
      ok: false,
      code: 409,
      error: `Job is ${job.status} — live step sirf zinda job pe jata hai.`,
    };
  }

  let pending: PendingStep;
  const now = new Date().toISOString();
  if (opts.stop) {
    pending = {
      id: randomUUID(),
      kind: "stop",
      injected_at: now,
      injected_by: opts.injectedBy,
    };
  } else {
    let stepJson = "";
    try {
      stepJson = JSON.stringify(opts.step ?? null);
    } catch {
      return { ok: false, code: 400, error: "step JSON-serializable hona chahiye." };
    }
    if (!opts.step || typeof opts.step !== "object" || Array.isArray(opts.step)) {
      return { ok: false, code: 400, error: "step ek object hona chahiye." };
    }
    if (stepJson.length > MAX_STEP_JSON) {
      return { ok: false, code: 400, error: "step bahut bada hai (max 4KB)." };
    }
    pending = {
      id: randomUUID(),
      kind: "step",
      step: opts.step,
      injected_at: now,
      injected_by: opts.injectedBy,
    };
  }

  const base =
    job.payload && typeof job.payload === "object"
      ? { ...(job.payload as Record<string, unknown>) }
      : {};
  const { error: upErr } = await sb
    .from("device_jobs")
    .update({ payload: { ...base, [PENDING_STEP_KEY]: pending } })
    .eq("id", opts.jobId);
  if (upErr) {
    return { ok: false, code: 500, error: "Step inject failed." };
  }
  return { ok: true, step_id: pending.id };
}

/**
 * Device poll: pending step nikalo aur turant clear karo (single delivery).
 * Clear id-matched hai — beech me aaya naya step clobber nahi hota:
 * filter miss hone pe dobara padhkar faisla karte hain, stale step
 * deliver nahi hota.
 */
export async function takePendingStep(
  sb: Sb,
  opts: { jobId: string; deviceId: string }
): Promise<{ kind: "step"; step: unknown } | { kind: "stop" } | null> {
  const { data: job } = await sb
    .from("device_jobs")
    .select("payload")
    .eq("id", opts.jobId)
    .eq("device_id", opts.deviceId)
    .maybeSingle();
  const pending = readPending(job?.payload);
  if (!pending) return null;

  // Id-matched clear: sirf wahi row clear hogi jisme abhi bhi YE step hai.
  const { data: cleared } = await sb
    .from("device_jobs")
    .update({ payload: withoutPending(job?.payload) })
    .eq("id", opts.jobId)
    .eq("device_id", opts.deviceId)
    .filter(`payload->${PENDING_STEP_KEY}->>id`, "eq", pending.id)
    .select("id");

  if (cleared && cleared.length > 0) {
    return pending.kind === "stop"
      ? { kind: "stop" }
      : { kind: "step", step: pending.step };
  }

  // Filter miss = beech me payload badla. Dobara padho:
  const { data: rejob } = await sb
    .from("device_jobs")
    .select("payload")
    .eq("id", opts.jobId)
    .eq("device_id", opts.deviceId)
    .maybeSingle();
  const now2 = readPending(rejob?.payload);
  if (now2 && now2.id === pending.id) {
    // Wahi step abhi bhi hai (ajeeb race) — ek retry, phir bhi na clear
    // ho to stale deliver karne se behtar hai null (agli poll pe milega).
    const { data: cleared2 } = await sb
      .from("device_jobs")
      .update({ payload: withoutPending(rejob?.payload) })
      .eq("id", opts.jobId)
      .eq("device_id", opts.deviceId)
      .filter(`payload->${PENDING_STEP_KEY}->>id`, "eq", pending.id)
      .select("id");
    if (cleared2 && cleared2.length > 0) {
      return pending.kind === "stop"
        ? { kind: "stop" }
        : { kind: "step", step: pending.step };
    }
  }
  // Naya step aa gaya ya step gaya — stale deliver nahi karenge.
  return null;
}
