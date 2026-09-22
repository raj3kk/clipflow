import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { encryptSecret } from "@/lib/crypto";

/**
 * p60 (2026-09-21): phone WebView session-token sync — USER-AUTHORIZED.
 *
 * Phone apne logged-in WebView ke cookies (sirf whop.com /
 * contentrewards.com) yahan bhejta hai taaki server USA IP se Whop-side
 * kaam (brief read, submit verify) kar sake. Instagram sync nahi hota —
 * IG upload native phone action hai.
 *
 * POST /api/agent/session/tokens  (device auth: X-Device-Id/X-Device-Key)
 *   { service: "whop"|"contentrewards", cookie_header, page_url? }
 *   → { ok:true, service }
 *
 * Storage: connections table (service, method="web-session"), secret_enc =
 * AES-256-GCM encrypted {cookie_header, page_url, ts}. Raw cookie kabhi
 * log nahi hota, kabhi response me wapas nahi jata.
 */
export const dynamic = "force-dynamic";

const SERVICES = ["whop", "contentrewards"] as const;

export async function POST(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const service = String(body.service ?? "");
  const cookieHeader = String(body.cookie_header ?? "");
  const pageUrl = String(body.page_url ?? "").slice(0, 500);

  if (!(SERVICES as readonly string[]).includes(service)) {
    return NextResponse.json(
      { error: `Unknown service: ${service}.` },
      { status: 400 }
    );
  }
  // DB check constraint: connections.service in
  // ('instagram','whop','gmail','content_rewards') — phone wire value
  // "contentrewards" ko yahan normalize karo (2026-09-21 fix).
  const dbService = service === "contentrewards" ? "content_rewards" : service;
  if (!cookieHeader || cookieHeader.length > 16384) {
    return NextResponse.json(
      { error: "cookie_header missing or too large." },
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
    secret_enc = encryptSecret({
      cookie_header: cookieHeader,
      page_url: pageUrl,
      ts: Date.now(),
    });
  } catch {
    return NextResponse.json(
      { error: "Cannot store session." },
      { status: 500 }
    );
  }

  const { error } = await sb.from("connections").upsert(
    {
      user_id: ident.userId,
      service: dbService,
      method: "web-session",
      label: "Phone WebView session (auto-synced)",
      status: "saved_unverified",
      secret_enc,
      last_verified: new Date().toISOString(),
    },
    { onConflict: "user_id,service,method" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, service });
}
