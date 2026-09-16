import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker endpoint: fetch render jobs waiting in the queue.
 * The VM render worker polls GET /api/jobs?status=queued
 */
export async function GET(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ jobs: [], configured: false });
  }
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "queued";
  const { data, error } = await sb
    .from("clips")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data, configured: true });
}
