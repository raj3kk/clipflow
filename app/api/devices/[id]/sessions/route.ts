import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Browser login-state sync (Browser Agent v1, 2026-09-21).
 *
 * POST /api/devices/:id/sessions (device auth: X-Device-Id + X-Device-Key)
 *   body: { sites: [{ site, logged_in, account_handle? }], at?, from? }
 *         ("sessions" key bhi accept hota hai — purane client compat)
 *   → 200 { ok: true, sites: <count> }
 *   → 401 bad device credentials, 404 device id mismatch
 *
 * SECRET RULE: body me sirf site/logged_in/handle aate hain — cookies ya
 * tokens KABHI nahi (phone pe SessionSync derive karta hai, bhejta nahi).
 * Extra fields ignore hote hain.
 *
 * Storage: device_sessions (device_id, site, logged_in, account_handle,
 * last_verified) — per site delete+insert (koi unique-constraint assume
 * nahi). instagram/whop ke logged_in=true pe devices.ig_session_ok_at /
 * whop_session_ok_at bhi refresh (heartbeat WP3 jaisa).
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;
  if (ident.deviceId !== params.id) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const list = body.sites ?? body.sessions;
  if (!Array.isArray(list)) {
    return NextResponse.json(
      { error: "sites must be an array." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  let count = 0;
  const sessUpdate: Record<string, string> = {};
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const site = String(e.site ?? "").trim().toLowerCase();
    if (!site || site.length > 64) continue;
    const loggedIn = e.logged_in === true;
    const handle =
      typeof e.account_handle === "string" && e.account_handle.length <= 128
        ? e.account_handle
        : null;
    // Purani row hatao, nayi dalo (constraint-free upsert)
    await sb
      .from("device_sessions")
      .delete()
      .eq("device_id", ident.deviceId)
      .eq("site", site);
    const { error: insErr } = await sb.from("device_sessions").insert({
      device_id: ident.deviceId,
      site,
      logged_in: loggedIn,
      account_handle: handle,
      last_verified: now,
    });
    if (insErr) continue;
    count++;
    if (loggedIn && site === "instagram") sessUpdate.ig_session_ok_at = now;
    if (loggedIn && site === "whop") sessUpdate.whop_session_ok_at = now;
  }

  if (Object.keys(sessUpdate).length > 0) {
    try {
      await sb.from("devices").update(sessUpdate).eq("id", ident.deviceId);
    } catch {
      /* best-effort */
    }
  }

  await touchDevice(ident.deviceId);
  return NextResponse.json({ ok: true, sites: count });
}
