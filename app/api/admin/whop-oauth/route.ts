import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin";
import { encryptSecret } from "@/lib/crypto";
import { getWhopOAuthAppConfig } from "@/lib/whop-oauth";

/**
 * Admin-managed Whop OAuth *app* credentials (client ID + secret).
 *
 * The OAuth app belongs to ClipFlow itself (one app for all users), so it is
 * global server config — but the owner can paste it here in the Admin panel
 * instead of touching Vercel env vars. Stored AES-256-GCM in the connections
 * table (service=whop, method=oauth-app); the secret is never returned.
 *
 * GET  -> { configured, source, clientIdMasked }
 * POST -> { client_id, client_secret } saves (owner-gated)
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const cfg = await getWhopOAuthAppConfig();
  return NextResponse.json({
    configured: !!cfg,
    source: cfg?.source ?? null,
    clientIdMasked: cfg
      ? cfg.clientId.slice(0, 8) + "…" + cfg.clientId.slice(-4)
      : null,
  });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }
  let body: { client_id?: string; client_secret?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const clientId = (body.client_id ?? "").trim();
  const clientSecret = (body.client_secret ?? "").trim();
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Client ID aur Client Secret dono chahiye." },
      { status: 400 }
    );
  }
  if (!clientId.startsWith("app_")) {
    return NextResponse.json(
      { error: "Client ID 'app_' se start hona chahiye — Whop dashboard se copy karke dobara try karo." },
      { status: 400 }
    );
  }
  // Bind to the owner (the signed-in admin) — global app config, one row.
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign-in required." }, { status: 401 });
  }
  const { error } = await sb.from("connections").upsert(
    {
      service: "whop",
      method: "oauth-app",
      user_id: sessionUser.id,
      label: "Whop OAuth app (ClipFlow)",
      status: "verified",
      secret_enc: encryptSecret({
        client_id: clientId,
        client_secret: clientSecret,
        saved_at: new Date().toISOString(),
      }),
      last_verified: new Date().toISOString(),
      meta: { kind: "oauth-app-config" },
    },
    { onConflict: "user_id,service,method" }
  );
  if (error) {
    return NextResponse.json(
      { error: `Save nahi hua: ${error.message}` },
      { status: 500 }
    );
  }
  // Sanity: never echo the secret back.
  return NextResponse.json({ ok: true });
}
