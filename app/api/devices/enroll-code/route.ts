import { NextResponse } from "next/server";
import { createHash, randomInt } from "crypto";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Signed-in user ke liye 6-digit enroll code banata hai (10 min valid).
 * User ye code phone app me dalta hai → POST /api/devices/enroll.
 *
 * POST /api/devices/enroll-code  →  { code, expires_at }
 */
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

  const code = String(randomInt(100000, 999999));
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await sb.from("device_enroll_codes").insert({
    user_id: user.id,
    code_hash: codeHash,
    expires_at: expiresAt,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ code, expires_at: expiresAt });
}
