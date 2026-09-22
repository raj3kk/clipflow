import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { handleOpsMessage, helpText } from "@/lib/ops_agent";

/**
 * POST /api/admin/ops-agent/chat — Ops Agent chat (admin only).
 *
 * Double-gated by requireAdmin(): owner email + httpOnly signed cf_admin
 * cookie. Bina gate ke 403/401 — koi info leak nahi.
 *
 * Body: { message: string } → { reply: string, actions_taken: string[] }
 * Deterministic rule-based agent hai — koi LLM call nahi, ₹0 cost.
 */
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;

  if (!isConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  let message = "";
  try {
    const body = await req.json();
    message = String(body?.message ?? "");
  } catch {
    message = "";
  }

  if (!message.trim()) {
    return NextResponse.json({ reply: helpText(), actions_taken: [] });
  }

  const res = await handleOpsMessage(sb, message);
  return NextResponse.json(res);
}
