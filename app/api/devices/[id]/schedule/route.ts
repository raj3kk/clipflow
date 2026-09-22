import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { validateSchedule, DEFAULT_SCHEDULE } from "@/lib/device_jobs";

/**
 * Device ka automation schedule dekho / badlo / hatao (dashboard).
 *
 * GET    /api/devices/:id/schedule  → { schedule, next_run, last_run }
 * PUT    /api/devices/:id/schedule  { schedule } → { ok, schedule }
 * DELETE /api/devices/:id/schedule  → schedule band (enabled:false)
 *
 * next_run: agle auto-job ka andaza (ISO) ya null (band / unknown).
 * last_run: pichhli run { finished_at, status } ya null (abhi tak koi run nahi).
 * Asli job creation server-side tick (POST /api/devices/schedule-tick) karta hai;
 * phone har 15 min poll karke queued job uthata hai.
 */
export async function GET(
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
    .select("id, schedule_json")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  const schedule = (device.schedule_json ?? DEFAULT_SCHEDULE) as Record<
    string,
    unknown
  >;

  // pichhli run
  const { data: lastRun } = await sb
    .from("job_runs")
    .select("finished_at, status")
    .eq("device_id", params.id)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const next_run = computeNextRun(schedule, lastRun?.finished_at ?? null);
  return NextResponse.json({
    schedule,
    next_run,
    last_run: lastRun ?? null,
  });
}

/** Agle scheduled run ka andaza. Band schedule → null. */
function computeNextRun(
  schedule: Record<string, unknown>,
  lastFinishedAt: string | null
): string | null {
  try {
    if (schedule.enabled === false) return null;
    const now = Date.now();
    if (schedule.mode === "times") {
      const times = (schedule.times ?? []) as string[];
      const tz =
        typeof schedule.timezone === "string" && schedule.timezone
          ? schedule.timezone
          : "Asia/Calcutta";
      let best: number | null = null;
      for (const t of times) {
        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
        if (!m) continue;
        // us timezone me aaj ka woh time → epoch ms
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(now));
        const get = (ty: string) => parts.find((p) => p.type === ty)?.value ?? "";
        const dayStr = `${get("year")}-${get("month")}-${get("day")}`;
        let guess = Date.parse(`${dayStr}T${t}:00Z`);
        for (let i = 0; i < 3; i++) {
          const offStr = new Intl.DateTimeFormat("en", {
            timeZone: tz,
            timeZoneName: "shortOffset",
          })
            .format(new Date(guess))
            .split("GMT")[1];
          guess = Date.parse(`${dayStr}T${t}:00Z`) - parseOffset(offStr) * 60 * 1000;
        }
        let target = guess;
        if (target <= now) target += 24 * 3600 * 1000; // kal
        if (best === null || target < best) best = target;
      }
      return best ? new Date(best).toISOString() : null;
    }
    // interval mode: agla epoch-anchored period boundary
    // (tick isi boundary pe job banata hai — UI aur tick ek jaise)
    const h = Number(schedule.interval_hours ?? 12);
    const periodMs = h * 3600 * 1000;
    const next = (Math.floor(now / periodMs) + 1) * periodMs;
    return new Date(next).toISOString();
  } catch {
    return null;
  }
}

function parseOffset(s: string | undefined): number {
  if (!s) return 0;
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s.trim());
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

export async function PUT(
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
  const v = validateSchedule(body.schedule);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 });
  }

  const { data, error } = await sb
    .from("devices")
    .update({ schedule_json: v.schedule })
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("id")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, schedule: v.schedule });
}

/**
 * Schedule hatao (galti se lag gaya to): enabled:false kar do.
 * Koi auto job nahi banega; sirf manual Run Now chalega.
 *
 * DELETE /api/devices/:id/schedule  → { ok, schedule }
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
  const schedule = { ...DEFAULT_SCHEDULE, enabled: false };
  const { data, error } = await sb
    .from("devices")
    .update({ schedule_json: schedule })
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("id")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, schedule });
}
