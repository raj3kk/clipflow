import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";

const ALLOWED = ["budget_remaining_usd", "join_status", "active", "notes"];

/** Update a campaign (budget, join status, active flag, notes). */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
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
    .from("campaigns")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
