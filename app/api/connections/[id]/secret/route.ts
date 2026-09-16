import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";

/**
 * Worker-only: fetch the ENCRYPTED secret envelope for a connection.
 *
 * The secret stays encrypted in transit (AES-256-GCM envelope
 * {iv,tag,data}); the VM worker decrypts it locally with
 * CONNECTIONS_ENCRYPT_KEY and uses it transiently. Never exposed to the
 * browser UI, never written to logs.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const auth = requireWorkerAuth(req);
  if (auth) return auth;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }
  const { data, error } = await sb
    .from("connections")
    .select("id, service, method, secret_enc")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Connection not found." },
      { status: 404 }
    );
  }
  if (!data.secret_enc) {
    return NextResponse.json(
      { error: "No secret stored for this connection." },
      { status: 404 }
    );
  }
  return NextResponse.json({
    id: data.id,
    service: data.service,
    method: data.method,
    secret_enc: data.secret_enc,
  });
}
