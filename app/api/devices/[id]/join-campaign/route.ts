import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob, logActivity } from "@/lib/device_jobs";
import { buildJoinCampaignPayload } from "@/lib/v2_workflow";

/**
 * Auto-join enqueue (Round-7, 2026-09-19).
 *
 * Whop ka campaign-join public API nahi deta, isliye join PHONE karta hai —
 * app ka WebView Whop me logged-in hai (user ne app me Whop login kiya tha).
 * Ye route sirf `join_campaign` job banata hai; phone ka dedicated handler
 * (JobEngine.runJoinCampaign) campaign page kholke Join dabata hai.
 *
 * POST /api/devices/:id/join-campaign  (x-worker-secret)
 *   { campaign_slug, campaign_url? }  →  { ok:true, job_id, deduped? }
 *
 * - campaign_url body me na ho to campaigns row ka campaign_url use hota hai.
 * - campaign_slug ka LIVE join_campaign job already ho → { deduped:true }
 *   (type-aware — clip "automation" job se confuse nahi hota).
 * - cap (4/24h) full → 429 (join job bhi cap me ginta hai).
 * - idempotency_key = join:<device_id>:<campaign_slug>.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body me JSON chahiye: { campaign_slug, campaign_url }." },
      { status: 400 }
    );
  }
  const b = body as Record<string, unknown>;
  const campaignSlug =
    typeof b.campaign_slug === "string" ? b.campaign_slug.trim() : "";
  if (!campaignSlug) {
    return NextResponse.json(
      { error: "campaign_slug chahiye (campaigns.id)." },
      { status: 400 }
    );
  }

  // device ka owner (user_id) nikaalo
  const { data: device } = await sb
    .from("devices")
    .select("id, user_id, status")
    .eq("id", params.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // campaign row — naam + campaign_url ke liye
  const { data: campaign } = await sb
    .from("campaigns")
    .select("id, name, campaign_url")
    .eq("id", campaignSlug)
    .eq("user_id", device.user_id)
    .single();
  if (!campaign) {
    return NextResponse.json(
      { error: `Campaign '${campaignSlug}' nahi mili.` },
      { status: 404 }
    );
  }

  const rawUrl =
    (typeof b.campaign_url === "string" && b.campaign_url.trim()) ||
    (campaign.campaign_url as string | null) ||
    "";
  const campaignUrl = rawUrl.trim();
  if (!/^https:\/\/.+/.test(campaignUrl)) {
    return NextResponse.json(
      {
        error:
          "campaign ka https campaign_url nahi hai — join page ka pata nahi, isliye join job nahi ban sakta.",
      },
      { status: 400 }
    );
  }

  // LIVE join dedup (type-aware): isi campaign ka join_campaign job already
  // queued/claimed/dispatched/running ho to naya mat banao.
  const { data: liveJoin } = await sb
    .from("device_jobs")
    .select("id, status")
    .eq("user_id", device.user_id)
    .eq("type", "join_campaign")
    .in("status", ["queued", "claimed", "dispatched", "running"])
    .eq("payload->>campaign_slug", campaignSlug)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (liveJoin) {
    return NextResponse.json({
      ok: true,
      job_id: (liveJoin as { id: string }).id,
      deduped: true,
    });
  }

  const res = await createAutomationJob(
    sb,
    device.user_id,
    device.id,
    "join_campaign",
    buildJoinCampaignPayload(campaignSlug, campaignUrl),
    { idempotency_key: `join:${device.id}:${campaignSlug}` }
  );

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.code ?? 500 });
  }
  if (!res.deduped) {
    await logActivity(
      sb,
      device.user_id,
      "join_enqueued",
      `📱 Auto-join: '${campaign.name}' — phone Whop pe join karega (job ${res.job_id.slice(0, 8)}…).`
    );
  }
  return NextResponse.json({
    ok: true,
    job_id: res.job_id,
    deduped: res.deduped === true,
  });
}
