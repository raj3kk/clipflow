import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { countCapUsage } from "@/lib/device_jobs";

/**
 * GET /api/devices/cap-status
 *
 * Rolling 24h automation cap ki live sthiti — Website (task d: Devices UI)
 * yahan se dikhayega: kitne slots use ho chuke, kitne bache, agla slot
 * kab khulega.
 *
 * Response: {
 *   used: number,        // counted automations (terminal-failure excluded)
 *   limit: 4,
 *   window_hours: 24,
 *   remaining: number,    // bache hue slots
 *   resets_at: string|null  // ISO — agla slot kab khulega (IST me format karo)
 * }
 *
 * Note: jo automation 3+ attempts me sahi se complete NA hui (terminal
 * failed) wo cap me count NAHI hoti — sirf genuine runs ka hisaab hai.
 */
export async function GET() {
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
  try {
    const usage = await countCapUsage(sb, user.id);
    return NextResponse.json(usage);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cap check failed." },
      { status: 500 }
    );
  }
}
