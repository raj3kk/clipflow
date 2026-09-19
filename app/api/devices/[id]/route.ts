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
    .is("deleted_at", null)
    .select("id, status, paused_until")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, device: data });
}

/**
 * Device hatao (dashboard) — SOFT DELETE.
 *
 * DELETE /api/devices/:id
 *   → { ok: true, restore_until: <ISO>, message: "7 din ke andar restore ho sakta hai" }
 *
 * Row delete NAHI hoti — deleted_at = now() set hota hai. Jobs, runs aur
 * screenshots bane rehte hain (restore pe sab wapas). 7 din purani
 * soft-deleted rows schedule-tick cleanup hard-delete karta hai.
 * POST /api/devices/:id/restore se wapas lao (7 din ke andar).
 * Phone pe app ka local enroll bana rehta hai — naya device chahiye to
 * app data clear karke naya code se enroll karo.
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

  const now = new Date();
  const { data: device, error } = await sb
    .from("devices")
    .update({ deleted_at: now.toISOString() })
    .eq("id", params.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();
  if (error || !device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const restoreUntil = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  return NextResponse.json({
    ok: true,
    restore_until: restoreUntil,
    message: "7 din ke andar restore ho sakta hai",
  });
}
