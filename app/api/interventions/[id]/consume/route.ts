import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { decryptSecret } from "@/lib/crypto";

/**
 * One-time consume of a resolved intervention value (worker only).
 *
 * Returns the decrypted value EXACTLY ONCE, then immediately NULLs value_enc
 * and marks the row 'consumed' — a second call returns 410. Requires the
 * x-worker-secret header when WORKER_SECRET is set.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const { data, error } = await sb
    .from("interventions")
    .select("id, kind, status, value_enc")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Intervention not found." }, { status: 404 });
  }
  if (data.status !== "resolved" || !data.value_enc) {
    return NextResponse.json(
      { error: `Value not available (status: ${data.status}). Already consumed or not yet resolved.` },
      { status: 410 }
    );
  }

  let value: unknown;
  try {
    value = decryptSecret<unknown>(data.value_enc as string);
  } catch (e) {
    return NextResponse.json(
      { error: `Decryption failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // Burn the value so it can never be read again.
  const { error: burnError } = await sb
    .from("interventions")
    .update({ value_enc: null, status: "consumed" })
    .eq("id", params.id)
    .eq("status", "resolved");
  if (burnError) {
    return NextResponse.json({ error: burnError.message }, { status: 500 });
  }

  return NextResponse.json({ id: data.id, kind: data.kind, value });
}
