import { NextResponse } from "next/server";
import { getDeviceIdentity } from "@/lib/device_auth";
import { getSupabase } from "@/lib/supabase";

/**
 * Free USA proxy for the phone (2026-09-21).
 *
 * GET /api/net/proxy  (x-device-id + x-device-key)
 *   → { ok:true, proxy:{ host, port, type }, checked_at }
 *   → { ok:false, error } (no working proxy right now)
 *
 * Phone configures OkHttp with Proxy(Type.HTTP, InetSocketAddress)
 * and fetches directly through it — no Vercel relay, true USA exit IP.
 * Vercel /api/net/egress remains as fallback.
 *
 * Query params:
 *   ?exclude=host:port  — proxy that just failed on the phone, skip it
 *   ?n=3               — return up to N proxies (phone tries in order)
 */
export async function GET(req: Request) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ ok: false, error: "db not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const excludeRaw = url.searchParams.get("exclude") || "";
  const exclude = new Set(
    excludeRaw.split(",").map((s) => s.trim()).filter(Boolean)
  );
  const n = Math.min(Math.max(parseInt(url.searchParams.get("n") || "3", 10) || 3, 1), 10);

  const { data, error } = await sb
    .from("proxy_pool")
    .select("host,port,proxy_type,latency_ms,last_working")
    .eq("country", "US")
    .eq("working", true)
    .order("latency_ms", { ascending: true, nullsFirst: false })
    .limit(25);

  if (error) {
    return NextResponse.json({ ok: false, error: "pool read fail" }, { status: 502 });
  }

  const fresh: Array<{ host: string; port: number; type: string }> = [];
  const cutoff = Date.now() - 90 * 60 * 1000; // 90 min freshness
  for (const r of data || []) {
    const key = `${r.host}:${r.port}`;
    if (exclude.has(key)) continue;
    const lw = r.last_working ? new Date(r.last_working).getTime() : 0;
    if (lw < cutoff) continue; // stale — pool refresher will re-test
    fresh.push({ host: r.host, port: r.port, type: r.proxy_type || "http" });
    if (fresh.length >= n) break;
  }

  if (fresh.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no working US proxy right now — try Vercel egress fallback" },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    proxies: fresh,
    checked_at: new Date().toISOString(),
  });
}
