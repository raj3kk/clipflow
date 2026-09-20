import { NextResponse } from "next/server";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { runBrain } from "@/lib/agent/brain";

/**
 * Server brain ka decide endpoint — worker-only (x-worker-secret).
 *
 * POST body:
 *   { user_id, device_id, goal?, pipeline_request_id?, dry_run? }
 *
 * goal: 'clip_post' | 'join' | 'discover' | 'verify' | 'recover'
 * dry_run=true → koi side effect nahi (no enqueue, no issue, no memory) —
 *   sirf decision return hota hai.
 *
 * Returns: { ok, decision, job_id?, issue_id?, cap }
 */

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!userId || !deviceId) {
    return NextResponse.json(
      { error: "user_id and device_id are required." },
      { status: 400 }
    );
  }
  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim()
      : "clip_post";
  const pipelineRequestId =
    typeof body.pipeline_request_id === "string" && body.pipeline_request_id.trim()
      ? body.pipeline_request_id.trim()
      : undefined;
  const campaign =
    body.campaign && typeof body.campaign === "object"
      ? (body.campaign as Record<string, unknown>)
      : undefined;
  const jobId =
    typeof body.job_id === "string" && body.job_id.trim()
      ? body.job_id.trim()
      : undefined;
  const dryRun = body.dry_run === true;

  try {
    const result = await runBrain(sb, {
      userId,
      deviceId,
      goal,
      pipeline_request_id: pipelineRequestId,
      campaign,
      job_id: jobId,
      dryRun,
    });
    return NextResponse.json({
      ok: result.ok,
      decision: result.decision,
      ...(result.job_id ? { job_id: result.job_id } : {}),
      ...(result.issue_id ? { issue_id: result.issue_id } : {}),
      cap: result.cap,
      verified: result.verified,
      attempts: result.attempts,
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message ?? e).slice(0, 200) },
      { status: 500 }
    );
  }
}
