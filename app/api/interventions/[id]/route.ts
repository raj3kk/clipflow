import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { encryptSecret } from "@/lib/crypto";

const PUBLIC_COLS =
  "id, kind, clip_id, question, detail, status, email_sent_at, resolved_at, resolved_via, created_at";

/**
 * Worker-only: record an intervention outcome.
 *
 * The VM worker calls this in two cases (see worker/interventions.py):
 *  - status "resolved": the owner replied by email; the reply text is passed
 *    as `value`, AES-256-GCM encrypted into value_enc so the one-time
 *    consume endpoint can return it exactly once.
 *  - status "expired": no owner reply within the timeout window.
 *
 * Guarded by x-worker-secret; scoped to the worker's ?user_id=. value_enc
 * is never selected into the response.
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
  const body = (await req.json()) as {
    status?: string;
    value?: unknown;
    email_sent_at?: string;
  };
  const { status, value, email_sent_at } = body;
  if (status !== "resolved" && status !== "expired") {
    return NextResponse.json(
      { error: 'status must be "resolved" or "expired".' },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (email_sent_at !== undefined) patch.email_sent_at = email_sent_at;
  if (status === "resolved") {
    patch.status = "resolved";
    patch.resolved_at = new Date().toISOString();
    patch.resolved_via = "worker";
    if (value !== undefined && value !== null && value !== "") {
      try {
        patch.value_enc = encryptSecret(value);
      } catch (e) {
        return NextResponse.json(
          { error: `Cannot store value: ${(e as Error).message}` },
          { status: 500 }
        );
      }
    }
  } else {
    patch.status = "expired";
  }

  const { data, error } = await sb
    .from("interventions")
    .update(patch)
    .eq("id", params.id)
    .eq("user_id", _wu)
    .select(PUBLIC_COLS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Intervention not found." },
      { status: 404 }
    );
  }
  return NextResponse.json({ intervention: data });
}
