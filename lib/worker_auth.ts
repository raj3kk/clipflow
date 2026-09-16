import { NextResponse } from "next/server";

/**
 * Guard for worker-only endpoints.
 *
 * If WORKER_SECRET is set, the caller must send it as the x-worker-secret
 * header. If WORKER_SECRET is unset, the guard is disabled (no auth required).
 *
 * Guarded routes: /api/jobs*, POST /api/activity, PATCH /api/posts/[id],
 * POST /api/interventions (worker creates), POST /api/submissions.
 *
 * Returns null when the request is allowed, otherwise a 401 NextResponse.
 */
export function requireWorkerAuth(req: Request): NextResponse | null {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return null;
  const got = req.headers.get("x-worker-secret");
  if (!got || got !== secret) {
    return NextResponse.json(
      { error: "Unauthorized: missing or invalid x-worker-secret." },
      { status: 401 }
    );
  }
  return null;
}
