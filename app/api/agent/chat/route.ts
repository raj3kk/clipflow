import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import {
  matchIntent,
  guideReply,
  startGuide,
  composeLiveReply,
  composeEarningsReply,
  composeOfflineReply,
  type GuideState,
  type OverviewData,
} from "@/lib/agent_kb";

/**
 * ClipFlow AI Agent — chat backend (₹0: koi external LLM nahi, intent-based).
 *
 * POST /api/agent/chat
 *   { message: string, guide?: { topic, step } }
 *   → { reply, link?, suggestions?, showRunNow?, guide? }
 *
 * Safety:
 * - Sirf signed-in user; saara data user_id = session user tak scoped.
 * - Agent yahan se koi run/post/delete KABHI trigger nahi karta — sirf padhta + batata hai.
 */

const ONLINE_MS = 5 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;

async function buildOverview(userId: string): Promise<OverviewData | null> {
  const sb = getSupabase();
  if (!sb || !isConfigured()) return null;

  const { data: devices } = await sb
    .from("devices")
    .select("id, device_name, status, last_seen, disconnected_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const now = Date.now();
  const nameById: Record<string, string> = {};
  const devList = (devices ?? []).map((d) => {
    const seen = d.last_seen ? new Date(d.last_seen).getTime() : 0;
    const age = now - seen;
    const presence = !seen ? "offline" : age < ONLINE_MS ? "online" : age < IDLE_MS ? "idle" : "offline";
    nameById[d.id] = d.device_name;
    return {
      id: d.id as string,
      device_name: d.device_name as string,
      presence: presence as "online" | "idle" | "offline",
      status: (d.disconnected_at ? "disconnected" : d.status) as string,
      last_seen: d.last_seen as string | null,
    };
  });

  const { data: activeJobs } = await sb
    .from("device_jobs")
    .select("device_id, type, status, created_at")
    .eq("user_id", userId)
    .in("status", ["queued", "claimed", "running"])
    .order("created_at", { ascending: false })
    .limit(10);

  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: runs } = await sb
    .from("job_runs")
    .select("status, finished_at, result")
    .eq("user_id", userId)
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(10);

  const { data: subs } = await sb
    .from("v2_submissions")
    .select("campaign_slug, whop_status, submitted_at")
    .eq("user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(20);

  const slugs = Array.from(
    new Set(
      (subs ?? [])
        .map((s) => s.campaign_slug)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );
  const nameBySlug: Record<string, string> = {};
  if (slugs.length > 0) {
    const { data: camps } = await sb
      .from("campaigns")
      .select("id, name")
      .eq("user_id", userId)
      .in("id", slugs);
    for (const c of camps ?? []) nameBySlug[c.id] = c.name;
  }

  return {
    devices: devList,
    activeJobs: (activeJobs ?? []).map((j) => ({
      device_name: nameById[j.device_id] ?? "device",
      type: j.type as string,
      status: j.status as string,
      created_at: j.created_at as string,
    })),
    recentRuns: (runs ?? []).map((r) => {
      let note = "";
      try {
        const res = r.result as Record<string, unknown> | null;
        if (res && typeof res.note === "string") note = res.note;
        else if (res && typeof res.error === "string") note = res.error;
      } catch {}
      return {
        status: r.status as string,
        finished_at: r.finished_at as string,
        note: note.slice(0, 120),
      };
    }),
    submissions: (subs ?? []).map((s) => ({
      campaign_name:
        typeof s.campaign_slug === "string" && s.campaign_slug
          ? (nameBySlug[s.campaign_slug] ?? null)
          : null,
      whop_status: s.whop_status as string | null,
      submitted_at: s.submitted_at as string,
    })),
  };
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: { message?: unknown; guide?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "message chahiye." }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message khaali hai." }, { status: 400 });
  }

  // ---- guide mode chal raha ho to step machine ----
  const g = body.guide as GuideState | null | undefined;
  if (g && typeof g.topic === "string" && typeof g.step === "number") {
    const r = guideReply({ topic: g.topic, step: g.step }, message);
    return NextResponse.json({
      reply: r.text,
      guide: r.guide,
      guideDone: r.done,
      link: r.link ?? null,
      suggestions: r.done
        ? ["Abhi kya chal raha hai?", "Abhi Run Karo"]
        : ["Ho gaya, agla step", "Pichla step", "Guide band karo"],
    });
  }

  const intent = matchIntent(message);

  // ---- naya guide shuru ----
  if (intent.startGuide) {
    const s = startGuide(intent.startGuide);
    return NextResponse.json({
      reply: s.text,
      guide: s.guide,
      guideDone: false,
      link: s.link,
      suggestions: ["Ho gaya, agla step", "Guide band karo"],
    });
  }

  // ---- real data wale intents ----
  if (intent.needsOverview) {
    const data = await buildOverview(user.id);
    if (!data) {
      return NextResponse.json({
        reply: "Abhi data nahi nikal paya (server setting adhoori hai). Thodi der me phir pucho.",
        suggestions: ["Coins kaise milte hain?", "Device enroll kaise karu?"],
      });
    }
    const text =
      intent.id === "live"
        ? composeLiveReply(data)
        : intent.id === "earnings"
          ? composeEarningsReply(data)
          : composeOfflineReply(data);
    return NextResponse.json({
      reply: text,
      link:
        intent.id === "live"
          ? { label: "Live page kholo", href: "/devices/live" }
          : intent.id === "offline"
            ? { label: "Live page kholo", href: "/devices/live" }
            : undefined,
      suggestions:
        intent.id === "earnings"
          ? ["Abhi kya chal raha hai?", "Abhi Run Karo"]
          : undefined,
      showRunNow: intent.id === "live" || intent.id === "offline",
    });
  }

  // ---- static intent ----
  return NextResponse.json({
    reply: intent.text,
    link: intent.link ?? null,
    suggestions: intent.suggestions,
    showRunNow: intent.showRunNow ?? false,
  });
}
