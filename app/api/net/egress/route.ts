import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";

/**
 * USA egress proxy (p35, 2026-09-20).
 *
 * Phone ke WebView ke Whop/ContentRewards requests ko US IP se forward
 * karta hai taaki region-locked campaigns ("not available in your region")
 * join ho saken. Vercel iad1 (Ashburn, Virginia, USA) se egress hota hai.
 *
 * POST /api/net/egress  (x-device-id + x-device-key)
 *   { url, method?, headers?, body_base64? }
 *   → { ok:true, status, headers, body_base64 }
 *   → { ok:false, error } (502)
 *
 * Guards:
 * - Sirf active enrolled device (device_auth).
 * - SSRF: sirf whop.com / contentrewards.com (aur subdomains).
 * - Sirf safe HTTP methods; 25s timeout; max ~8MB response.
 */
const ALLOWED_SUFFIXES = ["whop.com", "contentrewards.com"];
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

export async function POST(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Body me JSON chahiye." }, { status: 400 });
  }

  const urlStr = typeof b.url === "string" ? b.url.trim() : "";
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return NextResponse.json({ ok: false, error: "bad url" }, { status: 400 });
  }
  if (u.protocol !== "https:") {
    return NextResponse.json({ ok: false, error: "sirf https allowed" }, { status: 403 });
  }
  if (!hostAllowed(u.hostname)) {
    return NextResponse.json({ ok: false, error: "host not allowed" }, { status: 403 });
  }

  const method = typeof b.method === "string" ? b.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.includes(method)) {
    return NextResponse.json({ ok: false, error: "method not allowed" }, { status: 403 });
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  };
  const reqHeaders = (b.headers || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length" || lk === "connection") continue;
    headers[k] = String(v);
  }

  let body: Buffer | undefined;
  if (typeof b.body_base64 === "string" && b.body_base64) {
    body = Buffer.from(b.body_base64, "base64");
    if (body.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "body too large" }, { status: 413 });
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(u.toString(), {
      method,
      headers,
      body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "response too large" }, { status: 502 });
    }
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") return;
      // set-cookie ko alag se bhejo taaki multi-value na khoye
      if (lk === "set-cookie") {
        outHeaders["x-egress-set-cookie"] = v;
        return;
      }
      outHeaders[k] = v;
    });
    // set-cookie ke multiple values (undici getSetCookie)
    const setCookies: string[] =
      typeof (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (resp.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    return NextResponse.json({
      ok: true,
      status: resp.status,
      headers: outHeaders,
      set_cookies: setCookies,
      body_base64: buf.toString("base64"),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
