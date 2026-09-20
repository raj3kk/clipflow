import { NextResponse } from "next/server";
import { getDeviceIdentity, touchDevice } from "@/lib/device_auth";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { logActivity } from "@/lib/device_jobs";

/**
 * Job ka result: multipart form
 *   meta: JSON { status: succeeded|failed|blocked, vars: {...}, error? }
 *   shot_0..n: PNG screenshots (proof)
 *
 * Screenshots private bucket `device-shots` me jate hain
 * ({userId}/{jobId}/shot_i.png). Screenshot proof ke bina job
 * succeeded nahi hota — phone hamesha bhejta hai (JobEngine).
 *
 * status=blocked → device 24h auto-pause (IG action-block rule).
 */
const BLOCKED_PAUSE_HOURS = 24;

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
    .select("id, status, type, payload, user_id")
    .eq("id", params.id)
    .eq("device_id", ident.deviceId)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  }
  // IDEMPOTENT REPORT (2026-09-19 fix): phone kabhi-kabhi report dobara bhejta
  // hai (timeout-requeue race). Terminal state pe 409 ke bajaye 200 do —
  // taaki phone "report ho gaya" samajhke aage badhe, retry loop me na phase.
  if (["succeeded", "cancelled", "failed", "timeout"].includes(job.status)) {
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      status: job.status,
      duplicate: true,
    });
  }
  // 'queued' bhi accept karo: heartbeat-timeout ne beech me wapas queue kar
  // diya tha, lekin phone ne kaam poora karke report bheji hai.
  if (!["dispatched", "running", "queued"].includes(job.status)) {
    return NextResponse.json(
      { error: `Job already ${job.status}.` },
      { status: 409 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  let meta: { status?: string; vars?: Record<string, string>; error?: string };
  try {
    meta = JSON.parse(String(form.get("meta") ?? "{}"));
  } catch {
    return NextResponse.json({ error: "meta is not valid JSON." }, { status: 400 });
  }
  const status = meta.status ?? "failed";
  if (!["succeeded", "failed", "blocked"].includes(status)) {
    return NextResponse.json({ error: "Bad meta.status." }, { status: 400 });
  }

  // screenshots → private bucket
  const shotPaths: string[] = [];
  let i = 0;
  for (;;) {
    const f = form.get(`shot_${i}`);
    if (!f || typeof f === "string") break;
    const file = f as File;
    const buf = Buffer.from(await file.arrayBuffer());
    const path = `${ident.userId}/${params.id}/shot_${i}.png`;
    const { error: upErr } = await sb.storage
      .from("device-shots")
      .upload(path, buf, { contentType: "image/png", upsert: true });
    if (!upErr) shotPaths.push(path);
    i++;
    if (i > 20) break;
  }

  // LOCKED RULE: screenshot proof ke bina succeeded NAHI.
  // 400 → job state unchanged rehta hai (dispatched/running),
  // taaki phone screenshots ke saath dobara report kar sake.
  if (status === "succeeded" && shotPaths.length === 0) {
    return NextResponse.json(
      { error: "screenshots_required", detail: "succeeded needs >=1 screenshot proof." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  await sb.from("device_jobs").update({ status }).eq("id", job.id);
  // discover_detail job_runs.result me bhi rakho taaki debug me query ho sake
  const jobTypeEarly = (job as { type?: string }).type ?? "";
  const extraResult: Record<string, unknown> =
    jobTypeEarly === "discover_campaigns" && typeof meta.vars?.discover_detail === "string"
      ? { discover_detail: (meta.vars.discover_detail as string).slice(0, 2000) }
      : {};
  await sb.from("job_runs").insert({
    job_id: job.id,
    device_id: ident.deviceId,
    user_id: ident.userId,
    status,
    result: { vars: meta.vars ?? {}, error: meta.error ?? null, ...extraResult },
    screenshots: shotPaths,
    finished_at: now,
  });

  const campaignSlug =
    typeof (job.payload as Record<string, unknown> | null)?.campaign_slug ===
    "string"
      ? ((job.payload as Record<string, unknown>).campaign_slug as string)
      : null;

  const jobType = (job as { type?: string }).type ?? "";
  const isJoinJob = jobType === "join_campaign";
  // Phone ka dedicated join handler vars me join_status bhejta hai:
  // joined | already_joined | needs_user | failed
  const joinStatus =
    typeof meta.vars?.join_status === "string" ? meta.vars.join_status : null;
  const joinDetail =
    (typeof meta.vars?.join_detail === "string" && meta.vars.join_detail) ||
    meta.error ||
    "";

  // JOIN RESULT (Round-7, 2026-09-19): campaigns.joined / join_status update.
  // v2_submissions wala submit-flow join job pe NAHI chalta (join = submit nahi).
  if (isJoinJob && campaignSlug) {
    if (joinStatus === "joined" || joinStatus === "already_joined") {
      await sb
        .from("campaigns")
        .update({ joined: true, join_status: "joined" })
        .eq("id", campaignSlug)
        .eq("user_id", ident.userId);
      await logActivity(
        sb,
        ident.userId,
        "campaign_joined",
        `✅ '${campaignSlug}' Whop pe join ho gaya (phone auto-join` +
          (joinStatus === "already_joined" ? " — pehle se joined tha" : "") +
          `). Ab planner is campaign pe clip banayega.`
      );
    } else if (joinStatus === "needs_user") {
      // VISIBLE FLAG: Campaigns tab me join_status='needs_user' dikhega +
      // Activity me entry — user ko pata chalega uska action chahiye.
      await sb
        .from("campaigns")
        .update({ join_status: "needs_user" })
        .eq("id", campaignSlug)
        .eq("user_id", ident.userId);
      await logActivity(
        sb,
        ident.userId,
        "join_needs_user",
        `⚠️ '${campaignSlug}' auto-join ko TUMHARI zaroorat hai: ${joinDetail} ` +
          `Campaigns tab me dekho.`
      );
    } else {
      await logActivity(
        sb,
        ident.userId,
        "join_failed",
        `❌ '${campaignSlug}' auto-join fail: ${joinDetail} (30 min me retry hoga)`
      );
    }
  }

  // VERIFY RESULT (Round-7b, 2026-09-19): phone ne Whop pe candidates check
  // kiye — joined? requirements? video links? pehle submit? Result se
  // campaigns.notes me verified_* data + join_status update hota hai taaki
  // planner agli tick me VERIFIED campaign pe hi clip banaye (blind pick nahi).
  const isVerifyJob = jobType === "verify_campaigns";
  if (isVerifyJob) {
    const verifyStatus =
      typeof meta.vars?.verify_status === "string"
        ? (meta.vars.verify_status as string)
        : status === "succeeded"
          ? "verified"
          : "failed";
    const verifyDetail =
      (typeof meta.vars?.verify_detail === "string" &&
        (meta.vars.verify_detail as string)) ||
      meta.error ||
      "";
    let results: Array<Record<string, unknown>> = [];
    try {
      const raw = meta.vars?.verify_results;
      results = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>)
        : JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch {
      results = [];
    }
    for (const r of results) {
      const cid =
        typeof r.campaign_id === "string" ? r.campaign_id : "";
      if (!cid) continue;
      const { data: camp } = await sb
        .from("campaigns")
        .select("id, notes")
        .eq("id", cid)
        .eq("user_id", ident.userId)
        .single();
      if (!camp) continue;
      let notes: Record<string, unknown> = {};
      try {
        notes = JSON.parse((camp as { notes: string }).notes || "{}");
        if (typeof notes !== "object" || notes === null) notes = {};
      } catch {
        notes = {};
      }
      notes.verified_at = now;
      notes.verified_joined = r.joined === true;
      notes.verified_requirements =
        typeof r.requirements_text === "string"
          ? (r.requirements_text as string).slice(0, 2000)
          : "";
      notes.verified_video_links = Array.isArray(r.video_links)
        ? (r.video_links as unknown[]).slice(0, 10)
        : [];
      notes.whop_submitted = r.submitted === true;
      const patch: Record<string, unknown> = {
        notes: JSON.stringify(notes),
      };
      const js = r.join_status;
      if (js === "joined" || js === "already_joined" || r.joined === true) {
        patch.joined = true;
        patch.join_status = "joined";
      } else if (verifyStatus === "needs_user") {
        patch.join_status = "needs_user";
      }
      await sb.from("campaigns").update(patch).eq("id", cid);
    }
    const chosen =
      typeof meta.vars?.chosen_campaign_id === "string"
        ? (meta.vars.chosen_campaign_id as string)
        : "";
    await logActivity(
      sb,
      ident.userId,
      verifyStatus === "verified" ? "campaign_verified" : "verify_failed",
      verifyStatus === "verified"
        ? `✅ Whop verification poori: best-fit campaign '${chosen}' ` +
            `(joined, requirements + video links mile). Planner ab isi pe clip banayega.`
        : `⚠️ Campaign verification ${verifyStatus}: ${verifyDetail.slice(0, 200)}`
    );
  }

  // DISCOVER RESULT (Round-7b, 2026-09-19): phone ne Whop pe naye Content
  // Rewards campaigns dhoondhe — campaigns table me upsert (active=true).
  // Uske baad verify protocol (propose-campaigns) inpe chalega.
  const isDiscoverJob = jobType === "discover_campaigns";
  if (isDiscoverJob) {
    const discoverStatus =
      typeof meta.vars?.discover_status === "string"
        ? (meta.vars.discover_status as string)
        : status === "succeeded"
          ? "discovered"
          : "failed";
    const discoverDetail =
      (typeof meta.vars?.discover_detail === "string" &&
        (meta.vars.discover_detail as string)) ||
      meta.error ||
      "";
    let found: Array<Record<string, unknown>> = [];
    try {
      const raw = meta.vars?.discover_results;
      found = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>)
        : JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch {
      found = [];
    }
    let added = 0;
    // Nav/generic naam — ye campaigns nahi hain (server-side safety net;
    // app bhi filter karta hai lekin purane app versions se aa sakta hai).
    const NAV_NAME =
      /^(content rewards|bounties|joined|discover|home|dashboard|wallet|payouts?|settings|profile|notifications?|messages?|search|explore|earn|rewards)$/i;
    for (const f of found) {
      const url =
        typeof f.campaign_url === "string"
          ? (f.campaign_url as string).trim()
          : "";
      // whop.com, apps.whop.com, contentrewards.com — sab allowed
      // (Content Rewards app iframe se aane wale URLs)
      if (!/^https:\/\/(www\.)?(whop\.com|apps\.whop\.com|contentrewards\.com)\/.+/.test(url))
        continue;
      const name =
        (typeof f.name === "string" && (f.name as string).trim().slice(0, 120)) ||
        "Whop campaign";
      if (NAV_NAME.test(name)) continue;
      // id: URL slug se (stable), warna name slug
      let cid = "";
      try {
        const parts = new URL(url).pathname.split("/").filter(Boolean);
        cid = (parts[parts.length - 1] || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80);
      } catch {
        cid = "";
      }
      if (!cid) {
        cid = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80);
      }
      if (!cid) continue;
      // sponsor: campaigns.sponsor NOT NULL hai (2026-09-20 fix — iske bina
      // discover insert 23502 pe fail ho raha tha aur jhootha "jude" log
      // banta tha). Naam se brand nikalo: pehla shabd.
      const sponsorBase = name
        .replace(/\s*\(.*?\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const sponsor =
        (sponsorBase.split(" ")[0] || name || "Whop").slice(0, 60) || "Whop";
      // payout: "$1.50 per 1,000 views" jaisa text se number
      let payout: number | null = null;
      const pt =
        typeof f.payout_text === "string" ? (f.payout_text as string) : "";
      const pm = pt.match(/\$(\d+(?:\.\d+)?)/);
      if (pm) payout = parseFloat(pm[1]);
      const { data: existing } = await sb
        .from("campaigns")
        .select("id")
        .eq("user_id", ident.userId)
        .eq("id", cid)
        .limit(1)
        .single();
      if (existing) {
        await sb
          .from("campaigns")
          .update({ campaign_url: url, active: true })
          .eq("user_id", ident.userId)
          .eq("id", cid);
      } else {
        const { error: insErr } = await sb.from("campaigns").insert({
          id: cid,
          user_id: ident.userId,
          name,
          sponsor,
          campaign_url: url,
          payout_per_1k_usd: payout,
          active: true,
          joined: false,
          join_status: "not_joined",
          notes: JSON.stringify({ discovered_at: now, via: "phone" }),
        });
        if (insErr) {
          await logActivity(
            sb,
            ident.userId,
            "discover_insert_failed",
            `⚠️ Campaign '${name}' table me nahi jud paya: ${insErr.message.slice(0, 200)}`
          );
        } else {
          added++;
        }
      }
    }
    await logActivity(
      sb,
      ident.userId,
      discoverStatus === "discovered" ? "campaigns_discovered" : "discover_failed",
      discoverStatus === "discovered"
        ? `🔎 Phone ne Whop pe ${found.length} campaigns dekhe, ${added} naye campaigns table me jude. Ab verify hoga.` +
          (discoverDetail ? ` Debug: ${discoverDetail.slice(0, 500)}` : "")
        : `⚠️ Campaign discovery ${discoverStatus}: ${discoverDetail.slice(0, 200)}`
    );
  }

  // SUCCEEDED → v2_submissions me record (campaign dedup ka source of truth).
  // Phir isi campaign ke baaki live jobs cancel — dobara submit nahi hoga.
  // (join job pe nahi — join ka apna handling upar hai.)
  if (!isJoinJob && status === "succeeded" && campaignSlug) {
    await sb.from("v2_submissions").upsert(
      {
        user_id: ident.userId,
        device_id: ident.deviceId,
        job_id: job.id,
        campaign_slug: campaignSlug,
        reel_url: meta.vars?.reel_url ?? null,
        whop_status: "submitted",
        submitted_at: now,
      },
      { onConflict: "user_id,campaign_slug" }
    );
    // Is campaign ke baaki queued/dispatched/running jobs cancel karo.
    // (payload JSON me campaign_slug match — phone dobara submit nahi karega.)
    const { data: dupes } = await sb
      .from("device_jobs")
      .select("id")
      .eq("user_id", ident.userId)
      .in("status", ["queued", "dispatched", "running"])
      .neq("id", job.id);
    for (const d of dupes ?? []) {
      const { data: dj } = await sb
        .from("device_jobs")
        .select("payload")
        .eq("id", (d as { id: string }).id)
        .single();
      const slug = (dj?.payload as Record<string, unknown> | null)
        ?.campaign_slug;
      if (slug === campaignSlug) {
        await sb
          .from("device_jobs")
          .update({ status: "cancelled" })
          .eq("id", (d as { id: string }).id);
        await sb.from("job_runs").insert({
          job_id: (d as { id: string }).id,
          device_id: ident.deviceId,
          user_id: ident.userId,
          status: "cancelled",
          result: {
            error: `duplicate skipped — campaign '${campaignSlug}' pehle hi submit ho chuka hai`,
          },
          finished_at: now,
        });
      }
    }
  }

  // failed (retry bacha hai) → 30 min baad wapas queue.
  // RE-REPORT GUARD: phone ne yehi 'failed' pehle bhi report kiya tha to
  // dobara queue mat karo (nahi to failed↔queued loop chalta rehta hai).
  // needs_user = user ka action chahiye, auto-retry bekaar hai → terminal
  // 'failed' rehne do (Campaigns tab me 'needs_user' flag dikhega).
  const joinNeedsUser = isJoinJob && joinStatus === "needs_user";
  const verifyNeedsUser =
    isVerifyJob &&
    typeof meta.vars?.verify_status === "string" &&
    (meta.vars.verify_status as string) === "needs_user";
  const discoverNeedsUser =
    isDiscoverJob &&
    typeof meta.vars?.discover_status === "string" &&
    (meta.vars.discover_status as string) === "needs_user";
  if (status === "failed" && !joinNeedsUser && !verifyNeedsUser && !discoverNeedsUser) {
    // Abhi insert kiya hua 'failed' run sabse naya hai; usse pehle wala
    // run dekho — agar wo bhi 'failed' tha to ye re-report hai.
    const { data: runs } = await sb
      .from("job_runs")
      .select("status")
      .eq("job_id", job.id)
      .order("finished_at", { ascending: false })
      .limit(2);
    const prevFailed =
      Array.isArray(runs) &&
      runs.length >= 2 &&
      (runs[1] as { status: string }).status === "failed";
    if (!prevFailed) {
      const { data: j } = await sb
        .from("device_jobs")
        .select("attempts, max_attempts")
        .eq("id", job.id)
        .single();
      if (j && j.attempts < j.max_attempts) {
        await sb
          .from("device_jobs")
          .update({
            status: "queued",
            run_after: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          })
          .eq("id", job.id);
      }
    }
  }

  // blocked → device 24h pause
  if (status === "blocked") {
    await sb
      .from("devices")
      .update({
        status: "paused",
        paused_until: new Date(
          Date.now() + BLOCKED_PAUSE_HOURS * 3600 * 1000
        ).toISOString(),
      })
      .eq("id", ident.deviceId);
  }

  await touchDevice(ident.deviceId);
  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status,
    screenshots: shotPaths.length,
  });
}
