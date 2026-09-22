import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireWorkerAuth } from "@/lib/worker_auth";
import { createAutomationJob, logActivity } from "@/lib/device_jobs";
import {
  buildVerifyCampaignsPayload,
  type VerifyCandidate,
} from "@/lib/v2_workflow";

/**
 * Campaign verification enqueue (Round-7b, 2026-09-19).
 *
 * Server ke paas Whop user-login NAHI hai — campaign ka FINAL chunav isliye
 * PHONE karta hai (uska WebView Whop me logged-in hai). Server sirf top
 * candidates bhejta hai (payout-ranked); phone har candidate ka Whop page
 * kholke check karta hai: joined? requirements? official video links?
 * pehle submit hua? Phir best-fit choose karke (zaroorat ho to join karke)
 * result bhejta hai. Result route campaigns.notes me verified_* data likhta
 * hai; planner agli tick me verified campaign pe clip banata hai.
 *
 * POST /api/devices/:id/propose-campaigns  (x-worker-secret)
 *   { candidates: [{ campaign_id, name, campaign_url, payout_per_1k_usd }] }
 *   →  { ok:true, job_id, deduped? }
 *
 * - CAP-EXEMPT: ye verification hai, post nahi — 4/24h cap me nahi ginta.
 * - Device pe LIVE verify_campaigns job ho → { deduped:true } (dobara nahi).
 * - Server↔app coordination: dono verify karke kaam karte hain; server kabhi
 *   blind pick nahi karta.
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
      { error: "Body me JSON chahiye: { candidates: [...] }." },
      { status: 400 }
    );
  }
  const raw =
    (body as Record<string, unknown>).candidates as
      | Array<Record<string, unknown>>
      | undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json(
      { error: "candidates khaali hai — kam se kam 1 candidate chahiye." },
      { status: 400 }
    );
  }

  // device ka owner (user_id) nikaalo
  const { data: device } = await sb
    .from("devices")
    .select("id, user_id, status, app_version")
    .eq("id", params.id)
    .single();
  if (!device) {
    return NextResponse.json({ error: "Unknown device." }, { status: 404 });
  }

  // VERSION GUARD (Round-7b): verify_campaigns handler sirf p23+ me hai.
  // Purane app pe ye job generic run() me girega aur fail hoga — isliye
  // pehle app update karwao (force_update=true already published hai).
  const av = String(
    (device as { app_version?: string | null }).app_version ?? ""
  );
  const m = av.match(/p(\d+)/i);
  const pNum = m ? parseInt(m[1], 10) : 0;
  if (pNum < 23) {
    return NextResponse.json(
      {
        error:
          `Phone pe AutoClip ${av || "purana version"} hai — campaign ` +
          `verification ke liye p23 chahiye. App kholo, update install karo, ` +
          `phir dobara try hoga.`,
        needs_app_update: true,
      },
      { status: 409 }
    );
  }

  // candidates validate + normalize (max 5 — phone har page kholta hai)
  const candidates: VerifyCandidate[] = [];
  for (const c of raw.slice(0, 5)) {
    const cid =
      typeof c.campaign_id === "string" ? c.campaign_id.trim() : "";
    const url =
      typeof c.campaign_url === "string" ? c.campaign_url.trim() : "";
    if (!cid || !/^https:\/\/.+/.test(url)) continue;
    candidates.push({
      campaign_id: cid,
      name: typeof c.name === "string" ? c.name.slice(0, 120) : cid,
      campaign_url: url,
      payout_per_1k_usd:
        typeof c.payout_per_1k_usd === "number" ? c.payout_per_1k_usd : null,
    });
  }
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "Koi valid candidate nahi (campaign_id + https campaign_url chahiye)." },
      { status: 400 }
    );
  }

  // LIVE verify dedup (type-aware): is device ka verify_campaigns job already
  // queued/claimed/dispatched/running ho to naya mat banao.
  const { data: liveVerify } = await sb
    .from("device_jobs")
    .select("id, status")
    .eq("user_id", device.user_id)
    .eq("device_id", device.id)
    .eq("type", "verify_campaigns")
    .in("status", ["queued", "claimed", "dispatched", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (liveVerify) {
    return NextResponse.json({
      ok: true,
      job_id: (liveVerify as { id: string }).id,
      deduped: true,
    });
  }

  const res = await createAutomationJob(
    sb,
    device.user_id,
    device.id,
    "verify_campaigns",
    buildVerifyCampaignsPayload(candidates),
    {
      idempotency_key: `verify:${device.id}:${candidates
        .map((c) => c.campaign_id)
        .sort()
        .join(",")}`,
      // verify ka dedup sirf verify_campaigns jobs me — live clip/join job
      // verify ko rokegi nahi.
      campaignDedupTypes: ["verify_campaigns"],
    }
  );
  if (!res.ok) {
    const code = res.code === 404 ? 404 : res.code === 429 ? 429 : 409;
    return NextResponse.json({ error: res.error }, { status: code });
  }
  await logActivity(
    sb,
    device.user_id,
    "verify_requested",
    `🔍 Phone Whop pe ${candidates.length} campaigns verify karega ` +
      `(${candidates.map((c) => c.campaign_id).join(", ")}) — joined? ` +
      `requirements? video links? Phir best-fit choose hoga.`
  );
  return NextResponse.json({
    ok: true,
    job_id: res.job_id,
    deduped: res.deduped === true,
  });
}
