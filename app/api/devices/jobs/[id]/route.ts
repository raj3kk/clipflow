import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Phone ke liye lightweight progress endpoint — app poll karke apna
 * step-progress dikha sakti hai (docs/app-progress-protocol.md).
 *
 * GET /api/devices/jobs/:id  (X-Device-Id + X-Device-Key headers)
 *   →  { job_id, status, current_step, steps: [{ i, phase, action, state }],
 *        heartbeat: { count, last }, updated_at }
 *
 * step.state: "done" | "active" | "pending" | "unknown"
 *   - active = woh phase jo job.current_step se match karta hai
 *   - done = usse pehle ke phases, pending = baad ke
 *   - current_step kisi phase se match na ho → sab pending, active = "unknown"
 *
 * Auth: sirf apne device ka job (device_id match) — getDeviceIdentity.
 */
export async function GET(
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
    .select("id, status, type, current_step, last_heartbeat, heartbeat_count, payload, created_at, attempts")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();

  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  const rawSteps: { phase: string; action: string }[] = [];
  try {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const arr = payload.steps;
    if (Array.isArray(arr)) {
      for (const s of arr) {
        const o = s as Record<string, unknown>;
        rawSteps.push({
          phase: String(o.phase ?? ""),
          action: String(o.action ?? ""),
        });
      }
    }
  } catch {
    /* ignore */
  }

  const current = (job.current_step as string | null)?.trim() ?? "";
  const norm = (s: string) => s.trim().toLowerCase();
  // match: exact, ya ek doosre ka prefix (heartbeat me phase ke short
  // naam aa sakte hain, e.g. "ig-upload" vs "ig-uploading")
  let activeIdx = -1;
  if (current) {
    const c = norm(current);
    activeIdx = rawSteps.findIndex(
      (s) => {
        const p = norm(s.phase);
        return p === c || p.startsWith(c) || c.startsWith(p);
      }
    );
  }

  const steps = rawSteps.map((s, i) => ({
    i,
    phase: s.phase,
    action: s.action,
    state:
      activeIdx === -1
        ? "pending"
        : i < activeIdx
          ? "done"
          : i === activeIdx
            ? "active"
            : "pending",
  }));

  const TERMINAL = ["succeeded", "failed", "timeout", "cancelled"];
  const terminal = TERMINAL.includes(String(job.status));
  const stepsOut = terminal
    ? steps.map((s) => ({
        ...s,
        state: String(job.status) === "succeeded" ? "done" : s.state,
      }))
    : steps;

  return NextResponse.json({
    job_id: job.id,
    status: job.status,
    type: job.type,
    current_step: job.current_step,
    active_phase: activeIdx >= 0 ? steps[activeIdx].phase : "unknown",
    steps: stepsOut,
    heartbeat: {
      count: job.heartbeat_count ?? 0,
      last: job.last_heartbeat,
    },
    attempts: job.attempts,
    updated_at: job.last_heartbeat ?? job.created_at,
  });
}
