import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getRouteUserId } from "@/lib/auth";

/**
 * LIVE PREVIEW (2026-09-20 — user order):
 * Phone automation ke dauraan har 15 sec me apne WebView ka screenshot
 * yahan bhejta hai taaki web dashboard (Live page) pe dikhe phone abhi
 * kya kar raha hai — "kha kya garbari kr raha h" turant pata chale.
 *
 * POST /api/devices/:id/live-preview (device auth)
 *   multipart: shot (PNG)
 *   → { ok:true, at }
 *   Storage: device-shots/{userId}/{deviceId}/live.png (upsert — hamesha latest)
 *
 * GET /api/devices/:id/live-preview (user session auth)
 *   → PNG image (latest) ya 404
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const ident = await getDeviceIdentity(req);
  if ("error" in ident) return ident.error;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }
  const f = form.get("shot");
  if (!f || typeof f === "string") {
    return NextResponse.json({ error: "shot (PNG) required." }, { status: 400 });
  }
  const buf = Buffer.from(await (f as File).arrayBuffer());
  // 500KB se badi preview bekar hai — live view ke liye chhoti rakho
  if (buf.length > 500 * 1024) {
    return NextResponse.json({ error: "shot too large (max 500KB)." }, { status: 400 });
  }

  const path = `${ident.userId}/${params.id}/live.png`;
  const { error: upErr } = await sb.storage
    .from("device-shots")
    .upload(path, buf, { contentType: "image/png", upsert: true });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const now = new Date().toISOString();

  await touchDevice(params.id);
  return NextResponse.json({ ok: true, at: now });
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const _ident = await getRouteUserId(req);
  if ("error" in _ident) return _ident.error;
  const userId = _ident.userId;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  // Ownership check
  const { data: device } = await sb
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", userId)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const path = `${userId}/${params.id}/live.png`;
  const { data, error } = await sb.storage
    .from("device-shots")
    .download(path);
  if (error || !data) {
    return NextResponse.json(
      { error: "No live preview yet." },
      { status: 404 }
    );
  }

  const buf = Buffer.from(await data.arrayBuffer());
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache, no-store",
    },
  });
}
