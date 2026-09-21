import { NextResponse } from "next/server";

/**
 * Guard for worker-only endpoints.
 *
 * Accepts EITHER the worker secret OR the commander secret as the
 * x-worker-secret header (2026-09-21: the Commander agent — a dedicated
 * deterministic watcher that guides phone agents — authenticates with its
 * OWN token, never the assistant's worker token).
 *
 * If neither WORKER_SECRET nor COMMANDER_TOKEN is set, the guard is
 * disabled (no auth required).
 *
 * Guarded routes: /api/jobs*, POST /api/activity, PATCH /api/posts/[id],
 * POST /api/submissions.
 *
 * Returns null when the request is allowed, otherwise a 401 NextResponse.
 */
export function requireWorkerAuth(req: Request): NextResponse | null {
  const secrets = [process.env.WORKER_SECRET, process.env.COMMANDER_TOKEN].filter(
    (s): s is string => !!s
  );
  if (secrets.length === 0) return null;
  const got = req.headers.get("x-worker-secret");
  if (!got || !secrets.includes(got)) {
    return NextResponse.json(
      { error: "Unauthorized: missing or invalid x-worker-secret." },
      { status: 401 }
    );
  }
  return null;
}
