import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { toPublic } from "@/lib/connections";
import type { ConnectionService } from "@/lib/types";

const SERVICES: ConnectionService[] = [
  "instagram",
  "whop",
  "gmail",
  "content_rewards",
];

const ALLOWED = ["status", "last_verified", "label"];

/**
 * Worker-facing: GET /api/connections/<service> returns the newest saved
 * connection for that service WITH its encrypted secret envelope.
 * The VM worker decrypts the envelope locally with CONNECTIONS_ENCRYPT_KEY
 * and uses the secret transiently. Guarded by x-worker-secret.
 * (The dynamic segment is named [id] for the UI routes below; a value
 * matching a known service name is treated as a service lookup.)
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const auth = requireWorkerAuth(req);
  if (auth) return auth;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  if (!(SERVICES as string[]).includes(params.id)) {
    return NextResponse.json(
      { error: `Unknown service '${params.id}'. Use one of: ${SERVICES.join(", ")}.` },
      { status: 404 }
    );
  }
  const { data, error } = await sb
    .from("connections")
    .select("id, service, method, label, status, secret_enc, created_at")
    .eq("service", params.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json(
      { error: `No '${params.id}' connection saved yet.` },
      { status: 404 }
    );
  }
  if (!data.secret_enc) {
    return NextResponse.json(
      {
        error: `The '${params.id}' connection has no secret stored — reconnect with a method that saves credentials.`,
        id: data.id,
        service: data.service,
        method: data.method,
      },
      { status: 404 }
    );
  }
  return NextResponse.json({
    id: data.id,
    service: data.service,
    method: data.method,
    label: data.label,
    status: data.status,
    // Encrypted envelope {iv,tag,data}; the worker decrypts it locally.
    secret: data.secret_enc,
    has_secret: true,
  });
}

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
