import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { WHOP_TOKEN_URL } from "@/lib/whop-oauth";

const WHOP_API = "https://api.whop.com";

type WhopSecret = {
  kind: string;
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  whop_user_id?: string;
  client_id?: string;
  client_secret?: string;
};

/**
 * Worker-facing Whop API proxy.
 *
 * Why it exists: the VM worker's network cannot POST to Whop's hosts
 * (datacenter egress is tarpitted), but Vercel's can. So the worker sends
 * its Whop API calls here and this route forwards them with the user's
 * stored OAuth Bearer token (refreshing it when expired).
 *
 * Worker-authenticated (x-worker-secret) + ?user_id=<uuid>.
 * POST { method: "GET"|"POST"|"PATCH"|..., path: "/v5/me", query?: {...}, body?: {...} }
 * Never logs or returns tokens.
 */
export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;
  const userId = new URL(req.url).searchParams.get("user_id") ?? "";
  if (!userId) {
    return NextResponse.json(
      { error: "user_id query param is required." },
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

  let spec: { method?: string; path?: string; query?: Record<string, string>; body?: unknown };
  try {
    spec = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const method = (spec.method ?? "GET").toUpperCase();
  const path = spec.path ?? "";
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) || !path.startsWith("/")) {
    return NextResponse.json({ error: "Bad method or path." }, { status: 400 });
  }

  // Load the user's Whop OAuth connection.
  const { data: conn, error: connErr } = await sb
    .from("connections")
    .select("id, secret_enc, status")
    .eq("user_id", userId)
    .eq("service", "whop")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (connErr || !conn?.secret_enc) {
    return NextResponse.json(
      { error: "No Whop connection for this user." },
      { status: 404 }
    );
  }
  let secret: WhopSecret;
  try {
    secret = decryptSecret<WhopSecret>(conn.secret_enc as string);
  } catch {
    return NextResponse.json(
      { error: "Could not decrypt Whop credentials." },
      { status: 500 }
    );
  }
  if (secret.kind !== "oauth" || !secret.access_token) {
    return NextResponse.json(
      { error: "Whop connection is not OAuth — reconnect via Login with Whop." },
      { status: 400 }
    );
  }

  const connId = conn.id as string;

  // Refresh the access token when it is expired (or nearly).
  async function bearer(): Promise<string> {
    const skew = 60_000;
    if (
      secret.expires_at &&
      Date.now() < secret.expires_at - skew
    ) {
      return secret.access_token;
    }
    if (!secret.refresh_token || !secret.client_id || !secret.client_secret) {
      return secret.access_token; // nothing to refresh with — try anyway
    }
    const r = await fetch(WHOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: secret.refresh_token,
        client_id: secret.client_id,
        client_secret: secret.client_secret,
      }),
    });
    const t = await r.json();
    if (!r.ok || !t.access_token) {
      throw new Error("Whop token refresh failed — user must reconnect.");
    }
    secret = {
      ...secret,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? secret.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    };
    await sb!
      .from("connections")
      .update({ secret_enc: encryptSecret(secret) })
      .eq("id", connId);
    return secret.access_token;
  }

  try {
    const token = await bearer();
    const target = new URL(WHOP_API + path);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      target.searchParams.set(k, v);
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (spec.body !== undefined && method !== "GET") {
      init.body = JSON.stringify(spec.body);
    }
    const upstream = await fetch(target.toString(), init);
    const text = await upstream.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    return NextResponse.json(
      { ok: upstream.ok, status: upstream.status, data },
      { status: 200 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `Whop request failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}
