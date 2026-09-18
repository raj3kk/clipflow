import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Signed-in user ke devices ki list (dashboard → Devices tab).
 * api_key_hash kabhi wapas nahi bheja jata.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ devices: [], configured: false });
  }
  const { data, error } = await sb
    .from("devices")
    .select(
      "id, device_name, platform, app_version, status, paused_until, last_seen, created_at"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ devices: data ?? [], configured: true });
}
