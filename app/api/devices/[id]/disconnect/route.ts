import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Device disconnect karo (dashboard / Android app se unlink).
 *
 * POST /api/devices/:id/disconnect
 *   → 200 { ok: true, status: "disconnected" }
 *   → 404 { error: "Unknown device." }
 *
 * Disconnect ≠ delete, ≠ pause: row bani rehti hai, lekin phone ko
 * jobs/next se koi job nahi milta (device-auth 401 deta hai) aur
 * createAutomationJob bhi block hota hai. Phir se kaam chahiye to
 * naya enroll code se naya device enroll karo.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase not configured." }, { status: 503 });
  }

  const { data: device, error } = await sb
    .from("devices")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, status: "disconnected" });
}
