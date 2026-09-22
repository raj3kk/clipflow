import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob, logActivity } from "@/lib/device_jobs";
import {
  buildDiscoverCampaignsPayload,
  WHOP_DISCOVER_URL,
} from "@/lib/v2_workflow";

/**
 * Campaign discovery enqueue (Round-7b, 2026-09-19).
 *
 * Server ke paas Whop user-login NAHI hai — naye Content Rewards campaigns
 * bhi PHONE dhoondta hai (uska WebView Whop me logged-in hai). Phone
 * discover_url kholta hai (default https://whop.com/discover/content-rewards/), campaign cards
 * nikalta hai (name, campaign_url, payout) aur result bhejta hai; result
 * route unhe campaigns table me upsert karta hai. Uske baad verify protocol
 * (propose-campaigns) unpe chalta hai.
 *
 * POST /api/devices/:id/discover-campaigns  (x-worker-secret)
 *   { discover_url?: string }
 *   →  { ok:true, job_id, deduped? }
 *
 * - CAP-EXEMPT: ye discovery hai, post nahi — 4/24h cap me nahi ginta.
 * - Device pe LIVE discover_campaigns job ho → { deduped:true }.
 * - p24+ guard: purane app pe ye job fail hogi — pehle update karwao.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const denied = requireWorkerAuth(req);
  if (denied) return denied;

  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const rawUrl =
    typeof (body as Record<string, unknown>).discover_url === "string"
      ? ((body as Record<string, unknown>).discover_url as string).trim()
      : "";
  const discoverUrl = /^https:\/\/.+/.test(rawUrl) ? rawUrl : WHOP_DISCOVER_URL;

  const { data: device } = await sb
    .from("devices")
    .select("id, user_id, status, app_version")
    .eq("id", params.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // VERSION GUARD: discover handler sirf p24+ me hai.
  const av = String(
    (device as { app_version?: string | null }).app_version ?? ""
  );
  const m = av.match(/p(\d+)/i);
  const pNum = m ? parseInt(m[1], 10) : 0;
  if (pNum < 24) {
    return NextResponse.json(
      {
        error:
          `Phone pe AutoClip ${av || "purana version"} hai — campaign ` +
          `discovery ke liye p24 chahiye. App kholo, update install karo.`,
        needs_app_update: true,
      },
      { status: 409 }
    );
  }

  // LIVE discover dedup (type-aware)
  const { data: liveDiscover } = await sb
    .from("device_jobs")
    .select("id, status")
    .eq("user_id", device.user_id)
    .eq("device_id", device.id)
    .eq("type", "discover_campaigns")
    .in("status", ["queued", "claimed", "dispatched", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (liveDiscover) {
    return NextResponse.json({
      ok: true,
      job_id: (liveDiscover as { id: string }).id,
      deduped: true,
    });
  }

  // IDEMPOTENCY (2026-09-20 fix): static key `discover:${device.id}` purane
  // succeeded job ko hamesha dedupe-live manta tha → fresh scan kabhi nahi
  // hota tha. Daily-versioned key: same-day duplicate dedupe hota hai,
  // agle din fresh scan allowed hai.
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const res = await createAutomationJob(
    sb,
    device.user_id,
    device.id,
    "discover_campaigns",
    buildDiscoverCampaignsPayload(discoverUrl),
    {
      idempotency_key: `discover:${device.id}:${dayKey}`,
      campaignDedupTypes: ["discover_campaigns"],
    }
  );
  if (!res.ok) {
    const code = res.code === 404 ? 404 : res.code === 429 ? 429 : 409;
    return NextResponse.json({ error: res.error }, { status: code });
  }
  await logActivity(
    sb,
    device.user_id,
    "discover_requested",
    `🔎 Phone Whop pe naye Content Rewards campaigns dhoondhega — ` +
      `mile to campaigns table me judenge, phir verify hoga.`
  );
  return NextResponse.json({
    ok: true,
    job_id: res.job_id,
    deduped: res.deduped === true,
  });
}
