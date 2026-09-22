import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { guardNoActiveAutomation } from "@/lib/automation_guard";

/**
 * Run Now → full pipeline (zero-touch).
 *
 * POST /api/devices/:id/run-pipeline
 *   → 200 { ok, request_id } | 409 { error } (already pending/running)
 *
 * Device user ka hai + active (paused nahi) hona chahiye. `pending` request
 * insert karti hai — VM pe `pipeline_watch.py` watcher (1-min cron) ise
 * uthata hai aur `planner_v2.py` (campaign → render → phone enqueue) chalata hai.
 * Schedule wala hissa planner cron (6h) already karta hai; ye sirf manual trigger.
 *
 * GET /api/devices/:id/run-pipeline
 *   → { request: { id, status, note, created_at, started_at, finished_at,
 *                  stage, stage_at, attempts, next_retry_at } | null }
 *   Device ki latest pipeline request (UI status pill ke liye).
 *   stage = planner ka live phase (campaign_chun_rahe, video_download,
 *   clip_ban_raha, upload_ho_raha, phone_ko_bhej_rahe, ho_gaya).
 */
async function getOwnedDevice(userId: string, deviceId: string) {
  const sb = getSupabase()!;
  const { data: device } = await sb
    .from("devices")
    .select("id, status")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .single();
  return device;
}

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
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const device = await getOwnedDevice(user.id, params.id);
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }
  if (device.status !== "active") {
    return NextResponse.json(
      { error: `Device not active (status: ${device.status}).` },
      { status: 409 }
    );
  }

  // One-run-per-user guard (2026-09-19): ek time me ek hi automation.
  // Website AI agent "Abhi Run Karo" bhi UI se yahi route hit karta hai,
  // isliye server-side reject yahin hota hai — user click ke baad 409 milega.
  // Ek device pe ek hi request pending/running ho sakti hai — ye guard use
  // device-scoped check se upar (user-scoped) hai. Race me double-enqueue
  // DB partial unique index (pipeline_requests_active_device_uniq) rokta hai
  // — unique violation ko 409 me badalte hain.
  const conflict = await guardNoActiveAutomation(sb, user.id);
  if (conflict) return conflict;

  const { data: req, error: insErr } = await sb
    .from("pipeline_requests")
    .insert({
      user_id: user.id,
      device_id: params.id,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !req) {
    const msg = insErr?.message ?? "Insert failed.";
    if (/duplicate key|unique constraint|23505/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            "Ek automation pehle se chal rahi hai — uske complete/fail hone ka wait karo.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, request_id: req.id });
}

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
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  const device = await getOwnedDevice(user.id, params.id);
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  const { data: latest } = await sb
    .from("pipeline_requests")
    .select(
      "id, status, note, created_at, started_at, finished_at, stage, stage_at, attempts, next_retry_at"
    )
    .eq("device_id", params.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({ request: latest ?? null });
}
