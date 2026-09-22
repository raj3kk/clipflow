import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { generatePairingCode } from "@/lib/pairing";

/**
 * Admin-only: stateless pairing code banao (10 min valid, single-use).
 * User ye code phone app me dalta hai → POST /api/devices/enroll.
 * Koi DB write nahi — code HMAC-SHA256 signed hai (lib/pairing.ts).
 *
 * POST /api/pairing/generate  →  { code: "XXXXX-XXXX-XXXX", expires_at }
 */
export async function POST() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  try {
    const { code, expiresAt } = generatePairingCode();
    return NextResponse.json({ code, expires_at: expiresAt.toISOString() });
  } catch {
    return NextResponse.json(
      { error: "Pairing is not configured on the server." },
      { status: 503 }
    );
  }
}
