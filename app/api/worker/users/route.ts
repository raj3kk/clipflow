import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker-only: list the user IDs that have at least one saved connection.
 * The VM pipeline worker iterates these users and passes ?user_id= to every
 * worker endpoint, so each user's pipeline runs against their own data.
 * Guarded by x-worker-secret. Returns no emails or secrets — just user IDs.
 */
export async function GET(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ users: [], configured: false });
  }
  const { data, error } = await sb
    .from("connections")
    .select("user_id")
    .not("user_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ids = Array.from(new Set((data ?? []).map((r) => r.user_id as string)));
  return NextResponse.json({ users: ids.map((user_id) => ({ user_id })) });
}
