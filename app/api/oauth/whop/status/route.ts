import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";

/** Tells the Connections UI whether Whop OAuth is configured and connected. */
export async function GET(req: Request) {
  const configured = !!(
    process.env.WHOP_OAUTH_CLIENT_ID && process.env.WHOP_OAUTH_CLIENT_SECRET
  );
  const _ident = await getRouteUserId(req);
  if ("error" in _ident || !isConfigured()) {
    return NextResponse.json({ configured, connected: false });
  }
  const sb = getSupabase()!;
  const { data } = await sb
    .from("connections")
    .select("id, label, status, last_verified, meta")
    .eq("user_id", _ident.userId)
    .eq("service", "whop")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({
    configured,
    connected: !!data && data.status === "verified",
    connection: data
      ? {
          label: data.label,
          status: data.status,
          last_verified: data.last_verified,
          whop_user_id: (data.meta as Record<string, unknown> | null)
            ?.whop_user_id,
        }
      : null,
  });
}
