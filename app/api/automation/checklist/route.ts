import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSupabase, isConfigured } from "@/lib/supabase";

/**
 * Automation checklist — user ke latest (ya last completed) automation ke liye
 * ordered steps + live activity feed. Sirf signed-in user ka apna data.
 *
 * GET /api/automation/checklist  →  {
 *   request: { id, status, stage, stage_at, note, created_at, finished_at } | null,
 *   job:     { id, status, type, device_name, current_step, last_heartbeat, heartbeat_count } | null,
 *   steps:   [ { key, label, status, detail, updated_at } x 9 ],
 *   activity:[ { at, text, kind } ]   // last ~20, newest first
 * }
 *
 * Step keys (fixed order):
 *   campaign → download → render → plan → claim → upload → verify → submit → done
 *
 * Source of truth:
 *   - steps 0..3 (campaign..plan): pipeline_requests.stage (server-side stages)
 *   - steps 4..8 (claim..done):    device_jobs (status + current_step + heartbeat)
 *                                  + job_runs (phone result/reason)
 *
 * STEP MAPPING TABLE
 * ------------------
 * pipeline_requests.stage        → checklist frontier
 *   campaign_chun_rahe           → step 0 active  (campaign chuna ja raha hai)
 *   video_download               → step 1 active  (source download ho raha hai)
 *   clip_ban_raha                → step 2 active  (clip render ho raha hai)
 *   upload_ho_raha               → step 2 done, step 3 active (rendered clip
 *                                   hosting pe upload ho raha hai)
 *   taiyaar_ho_raha              → step 2 done, step 3 active (watchdog retry)
 *   phone_ko_bhej_rahe           → step 3 active  (enqueue ho raha hai)
 *   ho_gaya                      → step 3 done, step 4 active (server ka kaam
 *                                   khatam, ab phone ki baari)
 *   <unknown>                    → "active-unknown" — honest status, pending NAHI
 *
 * device_jobs.status             → checklist frontier
 *   queued                       → step 3 done, step 4 active
 *   dispatched / claimed          → step 4 done, step 5 active
 *   running (+ current_step)     → PHASE_MAP (neeche)
 *   succeeded                    → sab done (step 8 done)
 *   failed / timeout / cancelled → frontier step = failed (reason ke saath)
 *
 * PHONE PHASE MAP (device_jobs.current_step → active step):
 *   "download"                                   → 5 (phone clip download)
 *   ig-open..ig-share (ig-upload, ig-caption …)  → 5 (IG upload ho raha)
 *   ig-shared, ig-view, ig-reel-url, ig-extract,
 *     ig-time, ig-proof                          → 6 (upload done, verify active)
 *   verify-open, verify-video, verify-shot       → 6 (reel live verify)
 *   whop-open, whop-wait, whop-paste             → 7 (verify done, submit active)
 *   whop-submit, whop-confirm, whop-assert,
 *     whop-time, whop-proof                      → 7 (Whop submit ho raha)
 *   sub-open, sub-wait, sub-shot                 → 7 done, step 8 active
 *   guard-30min                                  → 8 active (final guard)
 *   <unknown phase>                              → "active-unknown"
 *
 * Status semantics: har step ka status ek "frontier" index se niklta hai —
 * frontier se pehle = done, frontier pe = active/failed, baad me = pending.
 * Frontier = max(server-stage frontier, job frontier). Terminal fail ho to
 * frontier wala step "failed" (reason ke saath), baad wale pending.
 */

export type StepStatus = "done" | "active" | "pending" | "failed" | "active-unknown";

export interface CheckStep {
  key: string;
  label: string;
  status: StepStatus;
  detail: string;
  updated_at: string | null;
}

const STEP_DEFS = [
  { key: "campaign", label: "Campaign chuna" },
  { key: "download", label: "Source video download" },
  { key: "render", label: "Clip render hua" },
  { key: "plan", label: "Phone ko job bheja (plan-job)" },
  { key: "claim", label: "Phone ne kaam uthaya" },
  { key: "upload", label: "Instagram pe upload" },
  { key: "verify", label: "Reel live verify" },
  { key: "submit", label: "Whop pe submit" },
  { key: "done", label: "Ho gaya" },
] as const;

/** pipeline stage → checklist frontier (iss step pe kaam chal raha hai). */
const STAGE_FRONTIER: Record<string, number> = {
  campaign_chun_rahe: 0,
  video_download: 1,
  clip_ban_raha: 2,
  upload_ho_raha: 3, // render done, plan (enqueue) active
  taiyaar_ho_raha: 3, // watchdog ne dobara taiyaar kiya — render done, plan active
  phone_ko_bhej_rahe: 3,
  ho_gaya: 4, // server done — ab phone claim karega
};

const STAGE_HINGLISH: Record<string, string> = {
  campaign_chun_rahe: "campaign chuna ja raha hai",
  video_download: "source video download ho raha hai",
  clip_ban_raha: "clip render ho raha hai",
  upload_ho_raha: "rendered clip hosting pe upload ho raha hai",
  taiyaar_ho_raha: "pipeline dobara taiyaar ho raha hai (retry)",
  phone_ko_bhej_rahe: "phone ko job bheja ja raha hai",
  ho_gaya: "server ka kaam poora — job phone ke paas",
};

const IG_UPLOAD_ACTIVE = new Set([
  "ig-open", "ig-login-check", "ig-popup", "ig-block-check",
  "ig-create-wait", "ig-create", "ig-upload", "ig-crop", "ig-original",
  "ig-proof-crop", "ig-next1", "ig-next2", "ig-caption-wait", "ig-caption",
  "ig-share",
]);
const IG_UPLOAD_DONE = new Set([
  "ig-shared", "ig-view", "ig-reel-url", "ig-extract", "ig-time", "ig-proof",
]);
const VERIFY_ACTIVE = new Set(["verify-open", "verify-video", "verify-shot"]);
const SUBMIT_ACTIVE = new Set([
  "whop-open", "whop-wait", "whop-paste",
  "whop-submit", "whop-confirm", "whop-assert", "whop-time", "whop-proof",
]);
const SUBMIT_DONE = new Set(["sub-open", "sub-wait", "sub-shot"]);

/**
 * Phone ka current_step phase → checklist frontier index.
 * Returns { frontier, unknown } — unknown phase ho to honest "active-unknown".
 */
function phaseFrontier(step: string | null): { frontier: number; unknown: boolean } {
  if (!step) return { frontier: 4, unknown: false };
  const s = step.trim();
  if (s === "download") return { frontier: 5, unknown: false };
  if (IG_UPLOAD_ACTIVE.has(s)) return { frontier: 5, unknown: false };
  if (IG_UPLOAD_DONE.has(s)) return { frontier: 6, unknown: false };
  if (VERIFY_ACTIVE.has(s)) return { frontier: 6, unknown: false };
  if (SUBMIT_ACTIVE.has(s)) return { frontier: 7, unknown: false };
  if (SUBMIT_DONE.has(s)) return { frontier: 8, unknown: false };
  if (s === "guard-30min") return { frontier: 8, unknown: false };
  // join_campaign type ke job ke phases (join-open …) — ye checklist ke
  // clip-flow steps me fit nahi hote; honest unknown.
  return { frontier: 5, unknown: true };
}

const JOB_TERMINAL_FAIL = new Set(["failed", "timeout", "cancelled"]);

interface ActivityEvent {
  at: string;
  text: string;
  kind:
    | "start" | "stage" | "job" | "step" | "upload" | "verify"
    | "submit" | "done" | "fail" | "retry";
}

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

  // ---- latest pipeline request: pehle active, warna last completed ----
  const { data: activeReq } = await sb
    .from("pipeline_requests")
    .select("id, status, stage, stage_at, note, created_at, started_at, finished_at, attempts, next_retry_at, device_id")
    .eq("user_id", user.id)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: false })
    .limit(1);
  let request: Record<string, unknown> | null = activeReq?.[0] ?? null;
  if (!request) {
    const { data: lastReq } = await sb
      .from("pipeline_requests")
      .select("id, status, stage, stage_at, note, created_at, started_at, finished_at, attempts, next_retry_at, device_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    request = lastReq?.[0] ?? null;
  }

  // device names (activity text ke liye)
  const nameById: Record<string, string> = {};
  const { data: devices } = await sb
    .from("devices")
    .select("id, device_name")
    .eq("user_id", user.id)
    .is("deleted_at", null);
  for (const d of devices ?? []) nameById[d.id as string] = String(d.device_name);

  // ---- latest automation jobs (type='automation') — newest 3, activity ke liye ----
  const { data: jobs } = await sb
    .from("device_jobs")
    .select("id, type, status, device_id, created_at, current_step, last_heartbeat, heartbeat_count, attempts")
    .eq("user_id", user.id)
    .eq("type", "automation")
    .order("created_at", { ascending: false })
    .limit(3);
  const jobList = (jobs ?? []) as Record<string, unknown>[];

  // ---- job_runs: latest job(s) ke runs (claim/result time + reason) ----
  const runByJob: Record<string, Record<string, unknown>[]> = {};
  if (jobList.length > 0) {
    const { data: runs } = await sb
      .from("job_runs")
      .select("id, job_id, device_id, status, started_at, finished_at, result")
      .eq("user_id", user.id)
      .in("job_id", jobList.map((j) => j.id as string))
      .order("started_at", { ascending: false })
      .limit(10);
    for (const r of runs ?? []) {
      const jid = r.job_id as string;
      (runByJob[jid] ??= []).push(r as Record<string, unknown>);
    }
  }

  // ---- correlation: kaunsa job is request ka hai? ----
  // job payload me request id nahi hoti; recency se jodte hain: latest ACTIVE
  // automation job, warna request ke time ke aas-paas ka latest job.
  let job: Record<string, unknown> | null = null;
  if (jobList.length > 0) {
    const active = jobList.find((j) =>
      ["queued", "dispatched", "claimed", "running"].includes(String(j.status))
    );
    if (active) {
      job = active;
    } else if (request) {
      const reqAt = new Date(String(request.created_at)).getTime();
      const near = jobList.find(
        (j) => Math.abs(new Date(String(j.created_at)).getTime() - reqAt) < 4 * 3600 * 1000
      );
      job = near ?? jobList[0];
    } else {
      job = jobList[0];
    }
  }

  // ---- frontier nikalo ----
  let frontier = -1; // -1 = kuch shuru nahi hua
  let frontierUnknown = false;
  let failReason = "";
  let failedStep = -1;

  if (request) {
    const stage = String(request.stage ?? "");
    if (stage in STAGE_FRONTIER) {
      frontier = Math.max(frontier, STAGE_FRONTIER[stage]);
    } else if (stage) {
      frontier = Math.max(frontier, 0);
      frontierUnknown = true; // unknown stage → honest, pending nahi
    } else if (String(request.status) === "failed") {
      frontier = Math.max(frontier, 0);
    }
    if (String(request.status) === "failed") {
      failedStep = Math.max(failedStep, Math.max(frontier, 0));
      failReason = String(request.note ?? "").slice(0, 160);
    }
  }

  let jobRuns: Record<string, unknown>[] = [];
  if (job) {
    jobRuns = runByJob[String(job.id)] ?? [];
    const js = String(job.status);
    if (js === "queued") {
      frontier = Math.max(frontier, 4);
    } else if (js === "dispatched" || js === "claimed") {
      frontier = Math.max(frontier, 5);
    } else if (js === "running") {
      const { frontier: pf, unknown } = phaseFrontier(
        job.current_step as string | null
      );
      frontier = Math.max(frontier, pf);
      if (unknown) frontierUnknown = true;
    } else if (js === "succeeded") {
      frontier = 8; // terminal — sab done
    } else if (JOB_TERMINAL_FAIL.has(js)) {
      const { frontier: pf, unknown } = phaseFrontier(
        job.current_step as string | null
      );
      frontier = Math.max(frontier, pf);
      if (unknown) frontierUnknown = true;
      failedStep = Math.max(failedStep, Math.max(frontier, 0));
      const lastRun = jobRuns[0];
      try {
        const res = (lastRun?.result ?? {}) as Record<string, unknown>;
        failReason =
          String(res.reason ?? res.error ?? res.note ?? "").slice(0, 160);
      } catch {
        /* ignore */
      }
    }
  }

  // request failed aur job succeeded → request ka failedStep hatao (job jeet gaya)
  if (job && String(job.status) === "succeeded") failedStep = -1;

  // ---- steps banao ----
  const steps: CheckStep[] = STEP_DEFS.map((def, i) => {
    let status: StepStatus = "pending";
    let detail = "";
    let updated_at: string | null = null;
    if (i < frontier) status = "done";
    else if (i === frontier) {
      status = failedStep === i ? "failed" : frontierUnknown ? "active-unknown" : "active";
    }

    const stage = String(request?.stage ?? "");
    switch (def.key) {
      case "campaign":
        detail = request
          ? frontier <= 0 && STAGE_HINGLISH[stage]
            ? STAGE_HINGLISH[stage]
            : String(request.note ?? "").slice(0, 120) || "campaign select ho gayi"
          : "abhi tak koi automation shuru nahi hui";
        updated_at = (request?.created_at as string) ?? null;
        break;
      case "download":
        detail = frontier >= 1 ? "source video download ho gaya" : stage === "video_download" ? "download ho raha hai…" : "";
        updated_at = (request?.stage_at as string) ?? null;
        break;
      case "render":
        detail =
          stage === "clip_ban_raha"
            ? "clip render ho raha hai…"
            : stage === "upload_ho_raha"
              ? "rendered clip hosting pe upload ho raha hai…"
              : frontier > 2
                ? "clip ready hai"
                : "";
        updated_at = (request?.stage_at as string) ?? null;
        break;
      case "plan":
        detail = job
          ? `job ${String(job.id).slice(0, 8)}… queue me gaya`
          : frontier >= 3
            ? "enqueue ho raha hai…"
            : "";
        updated_at = (job?.created_at as string) ?? (request?.stage_at as string) ?? null;
        break;
      case "claim":
        detail = job
          ? ["dispatched", "claimed", "running", "succeeded"].includes(String(job.status))
            ? `${nameById[String(job.device_id)] ?? "phone"} ne kaam utha liya`
            : "phone ke poll ka wait ho raha hai"
          : "";
        updated_at = (jobRuns[0]?.started_at as string) ?? (job?.last_heartbeat as string) ?? null;
        break;
      case "upload":
        detail = job?.current_step
          ? `phone pe: ${String(job.current_step)}`
          : frontier >= 5
            ? "phone kaam kar raha hai…"
            : "";
        updated_at = (job?.last_heartbeat as string) ?? null;
        break;
      case "verify":
        detail = job?.current_step && String(job.current_step).startsWith("verify")
          ? `live reel check: ${String(job.current_step)}`
          : frontier > 6
            ? "reel verify ho gayi"
            : "";
        updated_at = (job?.last_heartbeat as string) ?? null;
        break;
      case "submit":
        detail = job?.current_step && String(job.current_step).startsWith("whop")
          ? `Whop submit: ${String(job.current_step)}`
          : frontier > 7
            ? "Whop pe submit ho gaya"
            : "";
        updated_at = (job?.last_heartbeat as string) ?? null;
        break;
      case "done":
        if (job && String(job.status) === "succeeded") {
          detail = "poori automation poori hui ✓";
        } else if (failedStep >= 0) {
          detail = failReason ? `fail: ${failReason}` : "fail ho gaya";
        }
        updated_at =
          (jobRuns[0]?.finished_at as string) ??
          (job?.last_heartbeat as string) ??
          null;
        break;
    }
    if (status === "failed" && failReason && def.key !== "done") {
      detail = `fail: ${failReason}`;
    }
    if (status === "active-unknown") {
      detail = stage
        ? `server stage "${stage}" — ye stage checklist me map nahi hai`
        : job?.current_step
          ? `phone step "${String(job.current_step)}" — ye phase checklist me map nahi hai`
          : "pata nahi kaunsa step chal raha hai";
    }
    return { key: def.key, label: def.label, status, detail, updated_at };
  });

  // ---- activity feed (newest first, max 20) ----
  const activity: ActivityEvent[] = [];
  const push = (at: string | null | undefined, text: string, kind: ActivityEvent["kind"]) => {
    if (!at || !text) return;
    activity.push({ at, text, kind });
  };

  if (request) {
    const r = request;
    push(r.created_at as string, "Automation shuru — campaign chuna ja raha hai", "start");
    if (r.stage && r.stage_at) {
      push(
        r.stage_at as string,
        `Server stage: ${STAGE_HINGLISH[String(r.stage)] ?? `"${String(r.stage)}" (naya stage)`}`,
        "stage"
      );
    }
    if (r.finished_at) {
      push(
        r.finished_at as string,
        r.status === "done" ? "Planner ka kaam khatam" : `Planner fail ho gaya${r.note ? `: ${String(r.note).slice(0, 100)}` : ""}`,
        r.status === "done" ? "done" : "fail"
      );
    } else if (r.next_retry_at && String(r.status) === "failed") {
      push(r.next_retry_at as string, "Retry scheduled hai", "retry");
    }
  }

  for (const j of jobList) {
    const dname = nameById[String(j.device_id)] ?? "phone";
    push(j.created_at as string, `Phone ke liye job queue me gaya (${dname})`, "job");
    const runs = runByJob[String(j.id)] ?? [];
    for (const run of runs) {
      push(run.started_at as string, `${dname} ne kaam uthaya`, "job");
      if (run.finished_at) {
        let reason = "";
        try {
          const res = (run.result ?? {}) as Record<string, unknown>;
          reason = String(res.reason ?? res.error ?? res.note ?? "").slice(0, 120);
        } catch {
          /* ignore */
        }
        const ok = String(run.status) === "succeeded";
        push(
          run.finished_at as string,
          ok
            ? `${dname} ka kaam poora hua ✓`
            : `${dname} ka kaam fail hua${reason ? `: ${reason}` : ""}`,
          ok ? "done" : "fail"
        );
      }
    }
    if (["dispatched", "claimed", "running"].includes(String(j.status)) && j.current_step && j.last_heartbeat) {
      const step = String(j.current_step);
      let kind: ActivityEvent["kind"] = "step";
      let text = `${dname} pe abhi: ${step}`;
      if (step.startsWith("ig-")) { kind = "upload"; text = `${dname} Instagram pe upload kar raha hai (${step})`; }
      else if (step.startsWith("verify")) { kind = "verify"; text = `${dname} live reel verify kar raha hai (${step})`; }
      else if (step.startsWith("whop")) { kind = "submit"; text = `${dname} Whop pe submit kar raha hai (${step})`; }
      else if (step === "download") { text = `${dname} clip download kar raha hai`; }
      push(j.last_heartbeat as string, text, kind);
    }
  }

  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const feed = activity.slice(0, 20);

  return NextResponse.json({
    request: request
      ? {
          id: request.id,
          status: request.status,
          stage: request.stage,
          stage_at: request.stage_at,
          note: String(request.note ?? "").slice(0, 200),
          created_at: request.created_at,
          finished_at: request.finished_at,
        }
      : null,
    job: job
      ? {
          id: job.id,
          status: job.status,
          type: job.type,
          device_name: nameById[String(job.device_id)] ?? "unknown device",
          current_step: job.current_step,
          last_heartbeat: job.last_heartbeat,
          heartbeat_count: job.heartbeat_count,
        }
      : null,
    steps,
    activity: feed,
  });
}
