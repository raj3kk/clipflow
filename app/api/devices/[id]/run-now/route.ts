import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { guardNoActiveAutomation } from "@/lib/automation_guard";

/**
 * "Jab chahe" trigger — user dashboard se turant automation chalaye.
 *
 * POST /api/devices/:id/run-now
 *   → 200 { ok, request_id } | 409 { error } (already pending/running)
 *   → 400 { error } agar body me manual clip fields hon (override hata diya
 *      gaya hai — round-6 Worker E)
 *
 * 2026-09-19 (round-6): manual clip override (body me video_url / caption /
 * whop_submit_url) HATA DIYA. Ab ye route bilkul `run-pipeline` jaisa
 * automatic hai: `pipeline_requests` me `pending` row banti hai, VM pe
 * `pipeline_watch.py` watcher (1-min cron) ise uthata hai aur `planner_v2.py`
 * (campaign → render → phone enqueue) chalata hai. User ko kuch bharna nahi
 * padta (zero-touch). Koi UI caller nahi tha (AI agent + Devices page dono
 * `run-pipeline` pe hain) — ye route sirf backward-compat ke liye zinda hai.
 */

function isUniqueViolation(message: string): boolean {
  return /duplicate key|unique constraint|23505/i.test(message);
}

export async function POST(
  req: Request,
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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }

  // Manual clip override HATA DIYA — aise fields ab reject hote hain.
  if (
    body.video_url !== undefined ||
    body.caption !== undefined ||
    body.whop_submit_url !== undefined
  ) {
    return NextResponse.json(
      {
        error:
          "Manual clip override hata diya gaya hai. Ye route ab automatic hai — pipeline khud clip banayegi. Kuch bhejne ki zaroorat nahi.",
      },
      { status: 400 }
    );
  }

  const { data: device } = await sb
    .from("devices")
    .select("id, status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
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
  // Ek device pe ek hi request pending/running ho sakti hai (run-pipeline
  // jaisa) — ye guard use device-scoped check se upar (user-scoped) hai.
  // DB me partial unique index bhi hai (pipeline_requests_active_device_uniq)
  // — race me bhi double-enqueue impossible; unique violation ko 409 me
  // badalte hain.
  const conflict = await guardNoActiveAutomation(sb, user.id);
  if (conflict) return conflict;

  const { data: pr, error: insErr } = await sb
    .from("pipeline_requests")
    .insert({
      user_id: user.id,
      device_id: params.id,
      status: "pending",
      note: "run-now (manual trigger) — pipeline khud clip banayegi",
    })
    .select("id")
    .single();
  if (insErr || !pr) {
    const msg = insErr?.message ?? "Insert failed.";
    if (isUniqueViolation(msg)) {
      return NextResponse.json(
        {
          error:
            "Ek automation pehle se chal rahi hai — uske complete/fail hone ka wait karo.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ ok: true, request_id: pr.id });
}
