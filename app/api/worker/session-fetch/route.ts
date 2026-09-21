import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { decryptSecret } from "@/lib/crypto";

/**
 * p60 (2026-09-21): worker-only fetch using the phone-synced WebView session.
 *
 * VM worker ya cron ke paas Whop login nahi hai; phone apne WebView cookies
 * /api/agent/session/tokens pe sync karta hai (user-authorized). Ye route
 * un cookies se server-side (Vercel iad1, USA IP) HTTP request karta hai —
 * region-blocked reads (campaign brief, requirements) phone WebView ke
 * bina nikal aate hain.
 *
 * POST /api/worker/session-fetch  (x-worker-secret)
 *   { user_id, service: "whop"|"contentrewards", url, method? }
 *   → { ok:true, status, final_url, bytes, truncated, body_text }
 *   → { ok:false, error } (502)
 *
 * Guards:
 * - SSRF allowlist: sirf whop.com / contentrewards.com.
 * - Cookie kabhi response me nahi jata; body_text 200KB pe truncate.
 * - 25s timeout.
 */
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

const ALLOWED_SUFFIXES = ["whop.com", "contentrewards.com"];
const MAX_BODY_CHARS = 200_000;

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

export async function POST(req: Request) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const userId = String(body.user_id ?? "");
  const service = String(body.service ?? "");
  const url = String(body.url ?? "");
  const method = String(body.method ?? "GET").toUpperCase();

  if (!userId) {
    return NextResponse.json({ error: "user_id is required." }, { status: 400 });
  }
  if (service !== "whop" && service !== "contentrewards") {
    return NextResponse.json(
      { error: `Unknown service: ${service}.` },
      { status: 400 }
    );
  }
  // DB check constraint ke hisaab se normalize (tokens route jaisa):
  // wire "contentrewards" -> DB "content_rewards" (2026-09-21 fix).
  const dbService = service === "contentrewards" ? "content_rewards" : service;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return NextResponse.json({ error: "Invalid url." }, { status: 400 });
  }
  if (!hostAllowed(hostname)) {
    return NextResponse.json(
      { error: `Host not allowed: ${hostname}.` },
      { status: 403 }
    );
  }
  if (!["GET", "POST"].includes(method)) {
    return NextResponse.json(
      { error: "Only GET/POST are allowed." },
      { status: 400 }
    );
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const { data, error } = await sb
    .from("connections")
    .select("secret_enc")
    .eq("user_id", userId)
    .eq("service", dbService)
    .eq("method", "web-session")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: "No synced session for this service." },
      { status: 404 }
    );
  }

  let cookieHeader: string;
  try {
    const sess = decryptSecret<{ cookie_header?: string }>(data.secret_enc);
    cookieHeader = String(sess.cookie_header ?? "");
    if (!cookieHeader) throw new Error("empty");
  } catch {
    return NextResponse.json(
      { ok: false, error: "Stored session is unreadable." },
      { status: 500 }
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const text = await r.text();
    return NextResponse.json({
      ok: true,
      status: r.status,
      final_url: r.url,
      bytes: text.length,
      truncated: text.length > MAX_BODY_CHARS,
      body_text: text.slice(0, MAX_BODY_CHARS),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Fetch failed: ${String(e).slice(0, 200)}` },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
