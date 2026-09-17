import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";

/**
 * Poll an automated Whop OTP login attempt.
 *
 * GET /api/whop-otp/status?id=<intervention-uuid>
 * Returns the intervention status/step plus the current Whop connection
 * state, so the UI can show live progress without exposing any secrets.
 */
export async function GET(req: Request) {
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const { data: inv, error } = await sb
    .from("interventions")
    .select("id, kind, status, question, detail, resolved_via, created_at, resolved_at")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("kind", "whop_otp")
    .single();
  if (error || !inv) {
    return NextResponse.json({ error: "Attempt not found." }, { status: 404 });
  }

  const { data: whopConns } = await sb
    .from("connections")
    .select("id, method, status, last_verified, created_at")
    .eq("user_id", userId)
    .eq("service", "whop")
    .order("created_at", { ascending: false })
    .limit(1);

  const detail = (inv.detail ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    id: inv.id,
    status: inv.status,
    step: (detail.step as string) ?? "queued",
    error: (detail.error as string) ?? null,
    email: (detail.email as string) ?? null,
    resolved_via: inv.resolved_via ?? null,
    resolved_at: inv.resolved_at ?? null,
    whop_connection: whopConns && whopConns[0] ? whopConns[0] : null,
  });
}
