import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker endpoint: update a job (status, video_url, preview_urls, error).
 * Body: { status, video_url?, preview_urls?, error?, instagram_url?, posted_at?,
 *         scheduled_for?, verification?, qa_result? }
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const _wu = new URL(req.url).searchParams.get("user_id");
  if (!_wu) {
    return NextResponse.json(
      { error: "user_id query param is required for worker calls." },
      { status: 400 }
    );
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const allowed: Record<string, unknown> = {};
  for (const k of [
    "status",
    "video_url",
    "preview_urls",
    "error",
    "instagram_url",
    "posted_at",
    "scheduled_for",
    "verification",
    "qa_result",
  ]) {
    if (body[k] !== undefined) allowed[k] = body[k];
  }
  if (!allowed.status) {
    return NextResponse.json({ error: "status is required." }, { status: 400 });
  }
  const { data, error } = await sb
    .from("clips")
    .update(allowed)
    .eq("id", params.id)
    .eq("user_id", _wu)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
