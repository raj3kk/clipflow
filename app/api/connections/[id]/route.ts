import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { toPublic } from "@/lib/connections";

const ALLOWED = ["status", "last_verified", "label"];

/** Update connection metadata (status, last_verified, label). Secret changes go through POST. */
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
    .from("connections")
    .update(patch)
    .eq("id", params.id)
    .select("id, service, method, label, status, last_verified, secret_enc, meta, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connection: toPublic(data) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const { error } = await sb.from("connections").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: params.id });
}
