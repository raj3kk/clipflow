import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";

/**
 * Start an automated Whop email-OTP login for the signed-in user.
 *
 * POST /api/whop-otp/start { email }
 * Creates an intervention (kind=whop_otp, status=pending). The VM worker
 * picks it up: opens whop.com, submits the email, reads the fresh code
 * from the user's connected Gmail, verifies, and saves the session —
 * no session-id pasting needed.
 */
export async function POST(req: Request) {
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  // The code email must land in the Gmail account the user connected.
  const { data: gmailConns } = await sb
    .from("connections")
    .select("id")
    .eq("user_id", userId)
    .eq("service", "gmail")
    .limit(1);
  if (!gmailConns || gmailConns.length === 0) {
    return NextResponse.json(
      {
        error:
          "Connect Gmail first — the worker reads the Whop code from your connected Gmail inbox.",
      },
      { status: 400 }
    );
  }

  // One active OTP attempt per user at a time.
  const { data: existing } = await sb
    .from("interventions")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "whop_otp")
    .in("status", ["pending", "in_progress"])
    .limit(1);
  if (existing && existing.length > 0) {
    return NextResponse.json({ intervention_id: existing[0].id, resumed: true });
  }

  const { data, error } = await sb
    .from("interventions")
    .insert({
      kind: "whop_otp",
      user_id: userId,
      question: `Whop email-OTP login for ${email}`,
      detail: { email, step: "queued", error: null },
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ intervention_id: data.id }, { status: 201 });
}
