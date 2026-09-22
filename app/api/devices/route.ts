import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Signed-in user ke devices ki list (dashboard → Devices tab).
 * api_key_hash kabhi wapas nahi bheja jata.
 *
 * GET /api/devices
 *   → default: soft-deleted devices NAHI dikhte
 * GET /api/devices?include_deleted=true
 *   → deleted devices bhi, har ek me deleted_at + restore_days_left
 *
 * disconnected_at set ho to status "disconnected" dikhta hai
 * (disconnect ≠ delete, ≠ pause).
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ devices: [], configured: false });
  }

  const includeDeleted =
    new URL(req.url).searchParams.get("include_deleted") === "true";

  const q = sb
    .from("devices")
    .select(
      "id, device_name, platform, app_version, status, paused_until, last_seen, created_at, deleted_at, disconnected_at"
    )
    .eq("user_id", user.id);
  if (!includeDeleted) q.is("deleted_at", null);

  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const devices = (data ?? []).map((d) => {
    let restore_days_left: number | null = null;
    if (d.deleted_at) {
      const elapsed = now - new Date(d.deleted_at).getTime();
      restore_days_left = Math.max(
        0,
        7 - Math.floor(elapsed / (24 * 60 * 60 * 1000))
      );
    }
    return {
      ...d,
      status: d.deleted_at
        ? "deleted"
        : d.disconnected_at
          ? "disconnected"
          : d.status,
      restore_days_left,
    };
  });

  return NextResponse.json({
    devices,
    configured: true,
    include_deleted: includeDeleted,
  });
}
