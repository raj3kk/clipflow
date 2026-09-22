import { NextResponse } from "next/server";
import { getRouteUserId } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { createAutomationJob } from "@/lib/device_jobs";

/**
 * Naya automation job banao (dashboard / agent / worker).
 *
 * POST /api/devices/jobs
 *   { device_id, type, payload, idempotency_key? }
 *
 * CAP (user-set 2026-09-18): MAX 4 automations per rolling 2 days.
 * Cap cross hone pe 429 — phone ko kabhi 5th job milega hi nahi.
 */
export async function POST(req: Request) {
  const ident = await getRouteUserId(req);
  if ("error" in ident) return ident.error;
  const userId = ident.userId;

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
  const deviceId = String(body.device_id ?? "");
  const type = String(body.type ?? "custom");
  if (!deviceId) {
    return NextResponse.json({ error: "device_id is required." }, { status: 400 });
  }

  const res = await createAutomationJob(
    sb,
    userId,
    deviceId,
    type,
    (body.payload as Record<string, unknown>) ?? {},
    body.idempotency_key ? { idempotency_key: String(body.idempotency_key) } : undefined
  );

  if (!res.ok) {
    const { ok: _ok, code, ...rest } = res as { ok: false; code: number } & Record<string, unknown>;
    return NextResponse.json(rest, { status: code });
  }
  const { ok: _ok2, ...rest2 } = res;
  return NextResponse.json(rest2);
}
