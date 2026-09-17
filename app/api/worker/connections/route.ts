import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker-only: list a user's saved connections for ONE service, including
 * the ENCRYPTED secret envelopes. The VM worker decrypts them locally with
 * CONNECTIONS_ENCRYPT_KEY and uses them transiently.
 *
 * GET /api/worker/connections?service=gmail&user_id=<uuid>
 * Guarded by x-worker-secret. Decrypted secrets are never returned.
 */
const SERVICES = ["instagram", "whop", "gmail", "content_rewards"] as const;

export async function GET(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const service = url.searchParams.get("service") ?? "";
  const userId = url.searchParams.get("user_id") ?? "";

  if (!(SERVICES as readonly string[]).includes(service)) {
    return NextResponse.json({ error: `Unknown service: ${service}` }, { status: 400 });
  }
  if (!userId) {
    return NextResponse.json(
      { error: "user_id query param is required." },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured.", connections: [] },
      { status: 503 }
    );
  }

  const { data, error } = await sb
    .from("connections")
    .select("id, service, method, label, status, last_verified, secret_enc, created_at")
    .eq("user_id", userId)
    .eq("service", service)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ service, connections: data ?? [] });
}
