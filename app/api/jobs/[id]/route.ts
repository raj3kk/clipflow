import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Worker endpoint: update a job (status, video_url, preview_urls, error).
 * Body: { status, video_url?, preview_urls?, error? }
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const allowed: Record<string, unknown> = {};
  for (const k of ["status", "video_url", "preview_urls", "error", "instagram_url", "posted_at"]) {
    if (body[k] !== undefined) allowed[k] = body[k];
  }
  if (!allowed.status) {
    return NextResponse.json({ error: "status is required." }, { status: 400 });
  }
  const { data, error } = await sb
    .from("clips")
    .update(allowed)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
