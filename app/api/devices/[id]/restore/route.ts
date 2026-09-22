import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Soft-deleted device wapas lao.
 *
 * POST /api/devices/:id/restore
 *   → 200 { ok: true, device: { id, deleted_at: null } }
 *   → 410 { error: "restore_expired" } (deleted_at 7+ din purana ho)
 *   → 404 { error: "Unknown device." }
 *
 * Restore sirf tab hota hai jab deleted_at 7 din se purana NA ho.
 * disconnected_at ko ye endpoint nahi chherta.
 */
const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

  const { data: device } = await sb
    .from("devices")
    .select("id, deleted_at")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .not("deleted_at", "is", null)
    .single();

  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const deletedMs = new Date(device.deleted_at).getTime();
  if (isNaN(deletedMs) || Date.now() - deletedMs > RESTORE_WINDOW_MS) {
    return NextResponse.json({ error: "restore_expired" }, { status: 410 });
  }

  const { error } = await sb
    .from("devices")
    .update({ deleted_at: null })
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    device: { id: params.id, deleted_at: null },
  });
}
