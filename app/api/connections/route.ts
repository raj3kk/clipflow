import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { toPublic } from "@/lib/connections";
import type { Connection, ConnectionService } from "@/lib/types";

const SERVICES: ConnectionService[] = [
  "instagram",
  "whop",
  "gmail",
  "content_rewards",
];

export async function GET(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ connections: [], configured: false });
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;
  const { data, error } = await sb
    .from("connections")
    .select("*")
    .eq("user_id", userId)
    .order("service", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    connections: (data ?? []).map(toPublic),
    configured: true,
  });
}

/**
 * Create or update a connection. Body: { service, method, label?, secret? }.
 * secret is AES-256-GCM encrypted before storage; never logged or returned.
 * Upserts on (service, method); status becomes 'saved_unverified'.
 */
export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }
  const body = await req.json();
  const { service, method, label, secret, meta } = body as {
    service?: string;
    method?: string;
    label?: string;
    secret?: unknown;
    meta?: unknown;
  };
  if (!service || !SERVICES.includes(service as ConnectionService)) {
    return NextResponse.json(
      { error: `service is required. One of: ${SERVICES.join(", ")}.` },
      { status: 400 }
    );
  }
  if (!method || typeof method !== "string") {
    return NextResponse.json(
      { error: "method is required (e.g. 'oauth', 'session_cookie', 'app_password')." },
      { status: 400 }
    );
  }
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;

  let secret_enc: string | undefined;
  if (secret !== undefined && secret !== null && secret !== "") {
    try {
      secret_enc = encryptSecret(secret);
    } catch (e) {
      return NextResponse.json(
        { error: `Cannot store secret: ${(e as Error).message}` },
        { status: 500 }
      );
    }
  }

  const row: Record<string, unknown> = {
    service,
    method,
    user_id: userId,
    label: label ?? null,
    status: "saved_unverified",
    meta: meta ?? null,
  };
  // Only overwrite the stored secret when a new one was provided.
  if (secret_enc !== undefined) row.secret_enc = secret_enc;

  const { data, error } = await sb
    .from("connections")
    .upsert(row, { onConflict: "user_id,service,method" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connection: toPublic(data) }, { status: 201 });
}
