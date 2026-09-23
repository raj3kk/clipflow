import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { generatePairingCode, normalizeCode } from "@/lib/pairing";

/**
 * Signed-in user apne liye enroll code bana sakta hai
 * (pehle sirf admin bana sakta tha — "Admin access only").
 *
 * Code 10 min valid, single-use (lib/pairing.ts — stateless HMAC).
 * Code KISNE banaya, ye `activity_log` me event='pairing_code_issued'
 * se record hota hai — enroll route isi se device ko sahi user ke
 * account se jodta hai. Koi nayi table/column nahi.
 *
 * POST /api/pairing/generate  →  { code: "XXXXX-XXXX-XXXX", expires_at }
 *   signed out → 401
 *   10 min me 10+ active codes → 429
 */
const MAX_ACTIVE_CODES = 10;
const CODE_TTL_MS = 10 * 60 * 1000;

export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }
  try {
    // Halka per-user cap: 10 min window me max 10 active codes
    // (log spam / code-farming se bachao; legit use kabhi nahi atkega).
    const since = new Date(Date.now() - CODE_TTL_MS).toISOString();
    const { count } = await sb
      .from("activity_log")
      .select("id", { count: "exact", head: true })
      .eq("event", "pairing_code_issued")
      .eq("user_id", user.id)
      .gt("ts", since);
    if ((count ?? 0) >= MAX_ACTIVE_CODES) {
      return NextResponse.json(
        {
          error:
            "Bahut saare active codes — pehle wala use karo ya expire hone do.",
        },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    const { code, expiresAt } = generatePairingCode();
    const raw13 = normalizeCode(code);
    const { error: logErr } = await sb.from("activity_log").insert({
      user_id: user.id,
      actor: "pairing",
      event: "pairing_code_issued",
      detail: { code: raw13 },
    });
    if (logErr) {
      return NextResponse.json(
        { error: "Code issue failed. Dobara try karo." },
        { status: 503 }
      );
    }
    return NextResponse.json({ code, expires_at: expiresAt.toISOString() });
  } catch {
    return NextResponse.json(
      { error: "Pairing is not configured on the server." },
      { status: 503 }
    );
  }
}
