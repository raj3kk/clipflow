import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { sendWakePush } from "@/lib/fcm";

/**
 * Phone ko turant jagao (FCM push).
 *
 * POST /api/devices/:id/wake  →  { ok, via: "fcm"|"poll", reason? }
 *
 * FCM configured nahi hai to via:"poll" — phone apne schedule/poll se
 * kaam uthata rahega. Koi fake success nahi.
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

  const { data: device } = await sb
    .from("devices")
    .select("id, fcm_token")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  if (!device.fcm_token) {
    return NextResponse.json({
      ok: false,
      via: "poll",
      reason: "Phone ne FCM token register nahi kiya (app purana ya Firebase setup baaki).",
    });
  }

  const r = await sendWakePush(device.fcm_token);
  return NextResponse.json({ ok: r.sent, via: r.via, reason: r.reason });
}
