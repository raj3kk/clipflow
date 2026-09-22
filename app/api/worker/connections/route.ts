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

/**
 * Worker-only: save/rotate a user's connection secret.
 *
 * POST /api/worker/connections?user_id=<uuid>
 *   { service, method, label?, secret, status?, meta? }
 * The raw secret is encrypted server-side (AES-256-GCM) before storage —
 * the worker never sees or stores ciphertext, and raw values never appear
 * in logs or responses.
 */
export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") ?? "";
  if (!userId) {
    return NextResponse.json(
      { error: "user_id query param is required." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { service, method, label, secret, status, meta } = body as {
    service?: string;
    method?: string;
    label?: string;
    secret?: unknown;
    status?: string;
    meta?: unknown;
  };
  if (!(SERVICES as readonly string[]).includes(service ?? "")) {
    return NextResponse.json(
      { error: `Unknown service: ${service}` },
      { status: 400 }
    );
  }
  if (!method || typeof method !== "string") {
    return NextResponse.json(
      { error: "method is required (e.g. 'otp_auto', 'session_cookie')." },
      { status: 400 }
    );
  }
  if (secret === undefined || secret === null || secret === "") {
    return NextResponse.json(
      { error: "secret is required." },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let secret_enc: string;
  try {
    const { encryptSecret } = await import("@/lib/crypto");
    secret_enc = encryptSecret(secret);
  } catch (e) {
    return NextResponse.json(
      { error: `Cannot store secret: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  const row: Record<string, unknown> = {
    user_id: userId,
    service,
    method,
    label: label ?? null,
    secret_enc,
    status: status === "verified" ? "verified" : "saved_unverified",
    last_verified: status === "verified" ? new Date().toISOString() : null,
    meta: meta ?? null,
  };

  const { data, error } = await sb
    .from("connections")
    .upsert(row, { onConflict: "user_id,service,method" })
    .select("id, service, method, label, status, last_verified, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connection: data }, { status: 201 });
}
