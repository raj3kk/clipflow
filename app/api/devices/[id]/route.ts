import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Device pause / resume (dashboard, manual control).
 *
 * PATCH /api/devices/:id
 *   { action: "pause" }            → status='paused' (manual, indefinite)
 *   { action: "resume" }           → status='active', paused_until=null
 *   { action: "pause_until", until: <ISO> } → action-block jaisa timed pause
 *
 * Phone har poll pe status check karta hai — paused device ko job nahi milta.
 */
export async function PATCH(
  req: Request,
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = String(body.action ?? "");

  let patch: Record<string, unknown> | null = null;
  if (action === "pause") {
    patch = { status: "paused", paused_until: null };
  } else if (action === "resume") {
    patch = { status: "active", paused_until: null };
  } else if (action === "pause_until") {
    const until = String(body.until ?? "");
    if (!until || isNaN(Date.parse(until))) {
      return NextResponse.json({ error: "until (ISO datetime) required." }, { status: 400 });
    }
    patch = { status: "paused", paused_until: new Date(until).toISOString() };
  } else {
    return NextResponse.json(
      { error: 'action must be "pause", "resume" or "pause_until".' },
      { status: 400 }
    );
  }

  const { data, error } = await sb
    .from("devices")
    .update(patch)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("id, status, paused_until")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, device: data });
}

/**
 * Device hatao (dashboard).
 *
 * DELETE /api/devices/:id  → { ok: true }
 *
 * Device row delete hoti hai; device_jobs + job_runs FK cascade se
 * apne aap delete hote hain. Screenshots (device-shots bucket) best-effort
 * saaf hote hain — fail ho to device delete phir bhi hota hai.
 * Phone pe app ka local enroll bana rehta hai — dobara link karne ke
 * liye app data clear karke naya code se enroll karo.
 */
export async function DELETE(
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
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // screenshots best-effort saaf karo (bucket private hai)
  try {
    const { data: files } = await sb.storage
      .from("device-shots")
      .list(params.id, { limit: 1000 });
    const paths = (files ?? [])
      .filter((f) => f.name)
      .map((f) => `${params.id}/${f.name}`);
    if (paths.length > 0) {
      await sb.storage.from("device-shots").remove(paths);
    }
  } catch {
    /* best-effort — device delete phir bhi hoga */
  }

  const { error } = await sb
    .from("devices")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
