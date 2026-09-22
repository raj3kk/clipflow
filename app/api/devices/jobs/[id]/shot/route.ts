import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { mergeLiveSteps } from "@/lib/device_jobs";

/**
 * Mid-flow screenshot upload — OBSERVABILITY (2026-09-22 ground-zero rebuild).
 *
 * Root cause (jobs 7dd86beb / d0733fdc): phone mid-flow screenshots sirf job
 * ke END pe bhejta tha (result route) — timeout/fail pe evidence phone me hi
 * reh jati thi, server pe live_steps/live_frame khaali rehte the.
 *
 * Ab phone ka naya `shot_upload` step-action (app p70+) screenshot TURANT
 * yahan bhejta hai — job ke end ka wait nahi.
 *
 * POST /api/devices/jobs/:id/shot  (multipart form, X-Device-Id/X-Device-Key)
 *   name: string  → sanitize [a-z0-9_], max 40 chars
 *   shot: File    → JPEG/PNG, ≤500KB
 *   step?: string, phase?: string, msg?: string (optional text fields)
 *
 * Server:
 *   - device-shots bucket me {userId}/{jobId}/shot_{name}.jpg pe upsert
 *   - device_jobs.live_steps me event append {t, step, phase, msg, shot: path}
 *     (last 120 rakhi jati hain)
 *   - Unknown job → 404. Terminal job pe bhi accept (forensics) →
 *     {ok:true, terminal:true}.
 *   → {ok:true, path}
 */
const MAX_SHOT_BYTES = 500 * 1024;

function sanitizeName(raw: unknown): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s;
}

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

  const { data: job } = await sb
    .from("device_jobs")
    .select("id, status, user_id, live_steps")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const name = sanitizeName(form.get("name"));
  if (!name) {
    return NextResponse.json(
      { error: "name chahiye (a-z0-9_, max 40 chars)." },
      { status: 400 }
    );
  }
  const shotRaw = form.get("shot");
  if (!shotRaw || typeof shotRaw === "string") {
    return NextResponse.json({ error: "shot file chahiye." }, { status: 400 });
  }
  const shot = shotRaw as File;
  const buf = Buffer.from(await shot.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_SHOT_BYTES) {
    return NextResponse.json(
      { error: `shot 1 byte – 500KB ke beech hona chahiye (mila ${buf.length} bytes).` },
      { status: 400 }
    );
  }
  const step =
    typeof form.get("step") === "string"
      ? String(form.get("step")).slice(0, 120)
      : "";
  const phase =
    typeof form.get("phase") === "string"
      ? String(form.get("phase")).slice(0, 80)
      : "";
  const msg =
    typeof form.get("msg") === "string"
      ? String(form.get("msg")).slice(0, 300)
      : "";

  const path = `${ident.userId}/${params.id}/shot_${name}.jpg`;
  const { error: upErr } = await sb.storage
    .from("device-shots")
    .upload(path, buf, {
      contentType:
        typeof shot.type === "string" && shot.type.startsWith("image/")
          ? shot.type
          : "image/jpeg",
      upsert: true,
    });
  if (upErr) {
    return NextResponse.json(
      { error: `shot upload fail: ${upErr.message.slice(0, 200)}` },
      { status: 500 }
    );
  }

  // live_steps me forensics event (best-effort — upload ho gaya to ok hai)
  try {
    const now = new Date().toISOString();
    await sb
      .from("device_jobs")
      .update({
        live_steps: mergeLiveSteps(
          (job as { live_steps?: unknown }).live_steps,
          [
            {
              t: now,
              step: step || name,
              ...(phase ? { phase } : {}),
              ...(msg ? { msg } : {}),
              ok: true,
              shot: path,
            },
          ]
        ),
      })
      .eq("id", job.id);
  } catch {
    /* best-effort */
  }

  await touchDevice(ident.deviceId);

  const terminal = ["succeeded", "cancelled", "failed", "timeout"].includes(
    job.status
  );
  return NextResponse.json({ ok: true, path, ...(terminal ? { terminal: true } : {}) });
}
