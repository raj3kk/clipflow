import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

/**
 * Phone ko turant jagao (FCM push).
 *
 * HONEST STUB: FCM ke liye Firebase project + server key chahiye
 * (owner ka ~5 min ka kaam — ARCHITECTURE.md §12). Jab tak configured
 * nahi, phone apne schedule/poll se kaam uthata rahega.
 *
 * POST /api/devices/:id/wake  →  { ok, via }
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const fcmKey = process.env.FCM_SERVER_KEY;
  if (!fcmKey) {
    return NextResponse.json(
      {
        ok: false,
        via: "poll",
        reason:
          "FCM not configured (FCM_SERVER_KEY missing). Phone apne schedule pe job utha lega.",
      },
      { status: 501 }
    );
  }

  // FCM send yahan aayega jab key configure ho
  return NextResponse.json({ ok: false, via: "poll", reason: "Not implemented." }, { status: 501 });
}
