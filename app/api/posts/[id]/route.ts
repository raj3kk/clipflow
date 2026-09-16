import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

const ALLOWED = ["instagram_url", "posted_at", "verify_status", "verify_detail"];

/**
 * Worker endpoint: update a post after it actually goes live
 * (fills instagram_url + posted_at, updates verification state).
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
  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: `Nothing to update. Allowed fields: ${ALLOWED.join(", ")}.` },
      { status: 400 }
    );
  }
  const { data, error } = await sb
    .from("posts")
    .update(patch)
    .eq("id", params.id)
    .eq("user_id", _wu)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ post: data });
}
