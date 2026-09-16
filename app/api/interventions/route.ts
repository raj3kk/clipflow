import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Interventions: human-in-the-loop hand-off (OTP codes, approvals).
 *
 * FLOW (documented here — raw values never appear in logs or responses):
 *  1. Worker (or UI) creates: POST /api/interventions
 *       { kind, clip_id?, question, detail? } -> status 'pending'
 *     (worker calls require the x-worker-secret header when WORKER_SECRET set)
 *  2. Automation notifies the owner (email) with the question.
 *  3. Owner resolves via UI: POST /api/interventions/[id]/resolve
 *       { value, resolved_via } -> value AES-256-GCM encrypted into
 *       value_enc, status 'resolved', resolved_at set.
 *  4. Worker consumes: GET /api/interventions/[id]/consume (worker authed)
 *     -> decrypted value returned EXACTLY ONCE, then value_enc is nulled and
 *        status set to 'consumed'.
 *
 * value_enc is never selected into list/resolve responses.
 */

const PUBLIC_COLS =
  "id, kind, clip_id, question, detail, status, email_sent_at, resolved_at, resolved_via, created_at";

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ interventions: [], configured: false });
  }
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  let query = sb
    .from("interventions")
    .select(PUBLIC_COLS)
    .order("created_at", { ascending: false })
    .limit(50);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ interventions: data, configured: true });
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { kind, clip_id, question, detail } = body;
  if (!kind || !question) {
    return NextResponse.json(
      { error: "kind and question are required." },
      { status: 400 }
    );
  }
  const { data, error } = await sb
    .from("interventions")
    .insert({
      kind,
      clip_id: clip_id ?? null,
      question,
      detail: detail ?? null,
      status: "pending",
    })
    .select(PUBLIC_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ intervention: data }, { status: 201 });
}
