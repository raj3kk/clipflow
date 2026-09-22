/**
 * ClipFlow server brain — perceive → understand → reason → act → verify → adapt.
 *
 * Phone (AgentBrain) semantic page-understanding karta hai; ye server brain
 * usse ek level upar hai: wo decide karta hai KAUNSA kaam phone ko milega,
 * KIN constraints ke saath — scripted taps kabhi nahi, sirf directive
 * (goal + constraints + context).
 *
 * Act-gate ORDER (hard):
 *   1. mastery gate   (getSkillMastery — below 0.6 / needs_review → needs_review)
 *   2. compliance veto (compliance-guard.evaluate — veto → issue high + needs_review, kabhi enqueue nahi)
 *   3. cap gate        (checkCap — sirf counted types pe; housekeeping cap-exempt)
 *   4. enqueue         (createAutomationJob — directive payload me)
 *
 * Veto FINAL hai — brain usko override nahi kar sakta, sirf escalate.
 */

import { randomUUID } from "crypto";
import {
  checkCap,
  createAutomationJob,
  logActivity,
  isCountedAutomationType,
} from "@/lib/device_jobs";
import { SKILLS, getSkillMastery, type SkillKey } from "./skills";

export type ChosenAction =
  | "enqueue_phone_job"
  | "server_action"
  | "file_issue"
  | "wait"
  | "needs_review";

export interface Directive {
  goal: string;
  constraints: string[];
  context: Record<string, unknown>;
}

export interface Decision {
  goal: string;
  chosen_action: ChosenAction;
  rationale: string;
  confidence: number; // 0..1
  fallback: string;
  skill: string;
  directive?: Directive;
}

export interface Perception {
  device: {
    id: string;
    status: string | null;
    app_version: string | null;
    last_seen: string | null;
    online: boolean;
  } | null;
  liveJobs: Array<{ id: string; type: string | null; status: string | null; created_at: string | null }>;
  openIssueCount: number;
  highSeverityOpen: number;
  activeCampaignCount: number;
  lessonCount: number;
  lessons: Array<{ key: string; skill: string | null; summary: string }>;
}

export interface BrainOptions {
  userId: string;
  deviceId: string;
  /** 'clip_post' | 'join' | 'discover' | 'verify' | 'recover' (+ aliases) */
  goal?: string;
  pipeline_request_id?: string;
  /** campaign candidate (select-campaign / planner se aata hai) */
  campaign?: Record<string, unknown>;
  /** recover ke liye target job */
  job_id?: string;
  dryRun?: boolean;
}

export interface BrainRunResult {
  ok: boolean;
  decision: Decision;
  job_id?: string;
  issue_id?: string;
  cap?: { used: number; limit: number; remaining: number; resets_at: string | null } | null;
  verified: boolean;
  attempts: number;
  errors: string[];
}

const MAX_ATTEMPTS = 3;

/** goal → phone job type + gated skill + cap-counted? */
function goalPlan(goal: string): {
  jobType: string;
  skill: SkillKey;
  jobKind: string;
  directiveGoal: string;
} | null {
  switch (goal) {
    case "clip_post":
    case "post":
    case "automation":
      return {
        jobType: "automation",
        skill: "compliance-guard",
        jobKind: "clip",
        directiveGoal: "full_clip_post_pipeline",
      };
    case "join":
    case "join_campaign":
      return {
        jobType: "join_campaign",
        skill: "compliance-guard",
        jobKind: "join",
        directiveGoal: "join_campaign",
      };
    case "discover":
    case "discover_campaigns":
      return {
        jobType: "discover_campaigns",
        skill: "campaign-scout",
        jobKind: "discover",
        directiveGoal: "discover_campaigns",
      };
    case "verify":
    case "verify_campaigns":
      return {
        jobType: "verify_campaigns",
        skill: "campaign-scout",
        jobKind: "verify",
        directiveGoal: "verify_campaigns",
      };
    case "recover":
      return {
        jobType: "recover",
        skill: "recovery-specialist",
        jobKind: "recover",
        directiveGoal: "recover_stuck_run",
      };
    default:
      return null;
  }
}

/* ---------------- PERCEIVE ---------------- */

async function perceive(sb: any, userId: string, deviceId: string): Promise<Perception> {
  // device row
  let device: Perception["device"] = null;
  try {
    const { data } = await sb
      .from("devices")
      .select("id, status, app_version, last_seen")
      .eq("id", deviceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (data) {
      const lastSeen = data.last_seen ? new Date(data.last_seen).getTime() : 0;
      device = {
        id: data.id,
        status: data.status,
        app_version: data.app_version,
        last_seen: data.last_seen,
        online: lastSeen > 0 && Date.now() - lastSeen < 15 * 60 * 1000,
      };
    }
  } catch {
    /* perception best-effort — device na mile to reason me handle hoga */
  }

  // device ke live jobs
  let liveJobs: Perception["liveJobs"] = [];
  try {
    const { data } = await sb
      .from("device_jobs")
      .select("id, type, status, created_at")
      .eq("device_id", deviceId)
      .in("status", ["queued", "dispatched", "running"])
      .order("created_at", { ascending: false })
      .limit(10);
    liveJobs = (data ?? []) as Perception["liveJobs"];
  } catch {
    /* ignore */
  }

  // open issues
  let openIssueCount = 0;
  let highSeverityOpen = 0;
  try {
    const { data } = await sb
      .from("agent_issues")
      .select("id, severity")
      .eq("user_id", userId)
      .in("status", ["open", "investigating"])
      .limit(50);
    openIssueCount = (data ?? []).length;
    highSeverityOpen = (data ?? []).filter(
      (i: { severity: string }) => i.severity === "high"
    ).length;
  } catch {
    /* ignore */
  }

  // active campaigns (user ke)
  let activeCampaignCount = 0;
  try {
    const { count } = await sb
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("active", true);
    activeCampaignCount = count ?? 0;
  } catch {
    /* ignore */
  }

  // skill lessons + semantic memories (top by importance)
  const lessons: Perception["lessons"] = [];
  try {
    const { data } = await sb
      .from("agent_memory")
      .select("key, content, importance")
      .eq("user_id", userId)
      .in("kind", ["skill_lesson", "semantic"])
      .order("importance", { ascending: false })
      .limit(10);
    for (const m of data ?? []) {
      const c =
        m.content && typeof m.content === "object"
          ? (m.content as Record<string, unknown>)
          : {};
      lessons.push({
        key: String(m.key ?? ""),
        skill:
          typeof c.skill === "string"
            ? (c.skill as string)
            : typeof c.skill_key === "string"
              ? (c.skill_key as string)
              : null,
        summary: String(c.summary ?? c.lesson ?? "").slice(0, 300),
      });
    }
  } catch {
    /* ignore */
  }

  return {
    device,
    liveJobs,
    openIssueCount,
    highSeverityOpen,
    activeCampaignCount,
    lessonCount: lessons.length,
    lessons,
  };
}

/* ---------------- UNDERSTAND + REASON ---------------- */

function reason(p: Perception, opts: BrainOptions): Decision {
  const goal = (opts.goal ?? "clip_post").trim() || "clip_post";
  const plan = goalPlan(goal);
  const base: Decision = {
    goal,
    chosen_action: "needs_review",
    rationale: "",
    confidence: 0.5,
    fallback: "koi safe action nahi mila — human review ke liye roka",
    skill: plan?.skill ?? "compliance-guard",
  };

  // Device hi nahi / active nahi → aage kuch nahi
  if (!p.device) {
    base.rationale =
      `device ${opts.deviceId.slice(0, 8)}… user ke devices me nahi mila — ` +
      `phone ko job bhej hi nahi sakte.`;
    base.confidence = 0.9;
    base.fallback = "device enroll/activate hone ke baad dobara decide karo";
    return base;
  }
  if (p.device.status !== "active") {
    base.rationale =
      `device status '${p.device.status}' hai (active nahi) — job enqueue ka koi matlab nahi.`;
    base.confidence = 0.9;
    return base;
  }

  if (!plan) {
    base.rationale = `goal '${goal}' unknown hai — brain ko ye kaam karna nahi aata.`;
    base.confidence = 0.9;
    return base;
  }

  // High-severity open issues hain to confidence ghatao (machine state kharab ho sakti hai)
  let confidence = 0.85;
  if (p.highSeverityOpen > 0) confidence = Math.min(confidence, 0.55);

  const campaign = opts.campaign;

  if (goal === "recover") {
    // recovery-specialist: stuck job dhoondo (input job_id ya latest live job)
    const target =
      p.liveJobs.find((j) => j.id === opts.job_id) ?? p.liveJobs[0] ?? null;
    if (!target) {
      return {
        ...base,
        goal,
        chosen_action: "wait",
        rationale:
          "recover goal tha lekin device pe koi live (queued/dispatched/running) job hi nahi — kuch recover karne ko nahi.",
        confidence: 0.8,
        fallback: "naye job aane pe dobara dekho",
        skill: "recovery-specialist",
      };
    }
    return {
      ...base,
      goal,
      chosen_action: "file_issue",
      rationale:
        `device pe job ${target.id.slice(0, 8)}… '${target.status}' me atka hai ` +
        `(type: ${target.type ?? "?"}). recovery-specialist diagnosis: heartbeat/attempts ` +
        `dekhke root cause nikalo, blind retry nahi.`,
      confidence: 0.7,
      fallback: "phone online aake job uthaye to auto-resolve ho jayega",
      skill: "recovery-specialist",
      directive: {
        goal: "recover_stuck_run",
        constraints: [
          "blind retry nahi — pehle heartbeat_count, attempts, last error dekho",
          "root-cause hypothesis ke bina escalate nahi",
          "phone offline hai to wait karo, job ko mat chedo",
        ],
        context: { job_id: target.id, job_status: target.status, job_type: target.type },
      },
    };
  }

  // clip_post / join: campaign candidate mandatory hai
  if ((plan.jobKind === "clip" || plan.jobKind === "join") && !campaign) {
    return {
      ...base,
      goal,
      chosen_action: "needs_review",
      rationale:
        `goal '${goal}' ke liye campaign candidate caller ne diya hi nahi — ` +
        `bina campaign jaane compliance evaluate nahi ho sakta.`,
      confidence: 0.85,
      fallback: "/api/worker/select-campaign se candidate lao, phir dobara decide karo",
      skill: plan.skill,
    };
  }

  // Device pe pehle se live automation hai → naya enqueue mat karo (wait)
  if (plan.jobKind === "clip" && p.liveJobs.length > 0) {
    const j = p.liveJobs[0];
    return {
      ...base,
      goal,
      chosen_action: "wait",
      rationale:
        `device pe pehle se job ${j.id.slice(0, 8)}… '${j.status}' me live hai — ` +
        `uske complete/timeout hone tak naya clip_post enqueue nahi hoga (double-post se bachna hai).`,
      confidence: 0.85,
      fallback: "live job settle hone ke baad dobara decide karo",
      skill: plan.skill,
    };
  }

  // Normal path: enqueue_phone_job ka iraada — gates act() me lagenge
  const campaignCtx =
    campaign && typeof campaign === "object"
      ? {
          campaign_id: (campaign as Record<string, unknown>).id,
          campaign_name: (campaign as Record<string, unknown>).name,
        }
      : {};
  const constraints =
    plan.jobKind === "clip"
      ? [
          "Original 9:16 aspect — koi crop/zoom/trim nahi",
          "hook/title top edge se ≥10% neeche (safe zone)",
          "captions bottom UI zone se upar (caption overlay + buttons se bacho)",
          "submit se PEHLE live Reel ki frame-by-frame verify: ~1s (hook), ~7s/15s/25s (captions)",
          "post→submit 30 min ke andar",
          "koi purchase / subscribe / auto-pay nahi — payment dikhe to ruko aur report karo",
          "locked Content Rewards = valid unlock route (ye bypass nahi hai)",
          "scripted taps nahi — page ko samajhke semantic action lo",
        ]
      : plan.jobKind === "join"
        ? [
            "payment/paid-membership dikhe to JOIN MAT KARO — ruko aur report karo (needs_user)",
            "locked Content Rewards = valid unlock route (tap-to-unlock)",
            "join ke baad confirmation verify karo, sirf 'click ho gaya' kaafi nahi",
          ]
        : [
            "read-only discovery — koi join/post/submit nahi",
            "koi purchase / subscribe nahi",
          ];
  return {
    ...base,
    goal,
    chosen_action: "enqueue_phone_job",
    rationale:
      `goal '${goal}' — device active${p.device.online ? " aur online" : " (last_seen purana, phir bhi queue kar sakte hain)"}, ` +
      `koi blocking live job nahi, open high-severity issues: ${p.highSeverityOpen}. ` +
      `Directive me goal+constraints+context jayega (scripted taps nahi).`,
    confidence,
    fallback:
      "enqueue fail ho to skill lessons se naya reasoning, 3 attempts ke baad escalate",
    skill: plan.skill,
    directive: {
      goal: plan.directiveGoal,
      constraints,
      context: {
        ...campaignCtx,
        campaign: campaign ?? null,
      },
    },
  };
}

/* ---------------- helpers ---------------- */

export async function fileAgentIssue(
  sb: any,
  userId: string,
  agentId: string,
  severity: "low" | "medium" | "high",
  title: string,
  context: Record<string, unknown>,
  rootCauseHypothesis?: string
): Promise<string | null> {
  try {
    const { data, error } = await sb
      .from("agent_issues")
      .insert({
        user_id: userId,
        agent_id: agentId,
        severity,
        title: title.slice(0, 200),
        context,
        root_cause_hypothesis: rootCauseHypothesis ?? null,
        status: "open",
      })
      .select("id")
      .single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

async function persistDecision(
  sb: any,
  userId: string,
  decision: Decision,
  p: Perception,
  outcome: Record<string, unknown>
): Promise<void> {
  try {
    await sb.from("agent_memory").insert({
      user_id: userId,
      agent_id: "server-brain",
      kind: "brain_decision",
      key: randomUUID(),
      content: {
        decision,
        perception: {
          device_status: p.device?.status ?? null,
          device_online: p.device?.online ?? false,
          live_jobs: p.liveJobs.length,
          open_issues: p.openIssueCount,
          high_severity_open: p.highSeverityOpen,
          active_campaigns: p.activeCampaignCount,
        },
        outcome,
      },
      importance: Math.max(0, Math.min(1, decision.confidence)),
    });
  } catch {
    /* best-effort — decision pehle se return ho chuka hoga */
  }
}

/** Chhota brain_decision — job payload me embed hota hai (Live page pe dikhta hai). */
function smallDecision(decision: Decision): Record<string, unknown> {
  return {
    goal: decision.goal,
    chosen_action: decision.chosen_action,
    rationale: decision.rationale.slice(0, 300),
    confidence: decision.confidence,
    skill: decision.skill,
    at: new Date().toISOString(),
  };
}

/* ---------------- ACT (gates: mastery → veto → cap → enqueue) ---------------- */

interface ActOutcome {
  job_id?: string;
  issue_id?: string;
  cap?: BrainRunResult["cap"];
  verified: boolean;
  finalAction: ChosenAction;
  note: string;
}

async function act(
  sb: any,
  opts: BrainOptions,
  p: Perception,
  decision: Decision
): Promise<ActOutcome> {
  const plan = goalPlan((opts.goal ?? "clip_post").trim() || "clip_post");
  const userId = opts.userId;
  const deviceId = opts.deviceId;

  // server-side actions (koi phone job nahi)
  if (decision.chosen_action === "wait" || decision.chosen_action === "needs_review") {
    // needs_review pe bhi issue file karo taaki human ko dikhe (wait pe nahi — wo normal hai)
    let issue_id: string | undefined;
    if (decision.chosen_action === "needs_review") {
      const id = await fileAgentIssue(
        sb,
        userId,
        "server-brain",
        "medium",
        `Brain needs_review: ${decision.goal}`,
        { rationale: decision.rationale, skill: decision.skill },
        undefined
      );
      if (id) issue_id = id;
    }
    return { verified: true, finalAction: decision.chosen_action, note: "koi phone job nahi — server-side decision", issue_id };
  }

  if (decision.chosen_action === "file_issue") {
    // recover path: diagnosis ko issue me daalo
    const ctx = decision.directive?.context ?? {};
    const id = await fileAgentIssue(
      sb,
      userId,
      "server-brain",
      "medium",
      `Stuck run diagnosis: job ${String(ctx.job_id ?? "?").slice(0, 8)}…`,
      {
        rationale: decision.rationale,
        job_id: ctx.job_id,
        job_status: ctx.job_status,
        job_type: ctx.job_type,
        skill: decision.skill,
      },
      "heartbeat/attempts dekhke confirm karna hai — blind retry nahi"
    );
    await logActivity(
      sb,
      userId,
      "brain_recover",
      `Brain ne stuck job ${String(ctx.job_id ?? "?").slice(0, 8)}… pe diagnosis issue khola.`
    );
    return {
      verified: id !== null,
      finalAction: "file_issue",
      note: id ? `issue ${id.slice(0, 8)}… filed` : "issue file fail",
      issue_id: id ?? undefined,
    };
  }

  if (decision.chosen_action !== "enqueue_phone_job" || !plan) {
    throw new Error(`act: unexpected chosen_action '${decision.chosen_action}'`);
  }

  // ---- GATE 1: skill mastery (fail-closed) ----
  const mastery = await getSkillMastery(sb, userId, decision.skill);
  if (!mastery.autonomous) {
    const id = await fileAgentIssue(
      sb,
      userId,
      "server-brain",
      "low",
      `Skill mastery low — autonomous enqueue roka (${decision.skill})`,
      {
        rationale: decision.rationale,
        skill: decision.skill,
        mastery: mastery.mastery,
        needs_review: mastery.needs_review,
        missing: mastery.missing,
        note: mastery.note,
      },
      "skill abhi autonomous-ready nahi — human review ke baad mastery badhegi"
    );
    decision.chosen_action = "needs_review";
    decision.rationale += ` [mastery gate: ${mastery.note}]`;
    return {
      verified: true,
      finalAction: "needs_review",
      note: `mastery gate fail-closed: ${mastery.note}`,
      issue_id: id ?? undefined,
    };
  }

  // ---- GATE 2: compliance-guard HARD VETO (mandatory, override impossible) ----
  const campaignInput = opts.campaign
    ? {
        id: typeof opts.campaign.id === "string" ? opts.campaign.id : undefined,
        name: (opts.campaign.name as string | null) ?? null,
        requirements: (opts.campaign.requirements as string | null) ?? null,
        caption_template: (opts.campaign.caption_template as string | null) ?? null,
        hashtags: (opts.campaign.hashtags as string | null) ?? null,
        brief_url: (opts.campaign.brief_url as string | null) ?? null,
        campaign_url: (opts.campaign.campaign_url as string | null) ?? null,
        submitted: opts.campaign.submitted === true,
        notes:
          opts.campaign.notes && typeof opts.campaign.notes === "object"
            ? (opts.campaign.notes as Record<string, unknown>)
            : null,
      }
    : undefined;
  const vetoRes = SKILLS["compliance-guard"].evaluate({
    campaign: campaignInput,
    job_kind: plan.jobKind,
  });
  if (vetoRes.veto) {
    const paymentHit = vetoRes.reasons.some((r) =>
      r.toLowerCase().includes("payment")
    );
    const id = await fileAgentIssue(
      sb,
      userId,
      "server-brain",
      "high",
      `Compliance VETO — ${plan.jobKind} enqueue roka`,
      {
        rationale: decision.rationale,
        veto_reasons: vetoRes.reasons,
        campaign_id: campaignInput?.id ?? null,
        campaign_name: campaignInput?.name ?? null,
        needs_user: paymentHit || undefined,
      },
      paymentHit
        ? "payment-looking flow — user ko khud decide karna hai (auto-pay kabhi nahi)"
        : "compliance gate fail — campaign candidate compliant nahi"
    );
    await logActivity(
      sb,
      userId,
      "brain_veto",
      `Compliance VETO: ${plan.jobKind} enqueue roka — ${vetoRes.reasons[0]?.slice(0, 120) ?? ""}`
    );
    decision.chosen_action = "needs_review";
    decision.rationale += ` [COMPLIANCE VETO: ${vetoRes.reasons.join(" | ").slice(0, 300)}]`;
    return {
      verified: true,
      finalAction: "needs_review",
      note: "compliance veto — enqueue kabhi nahi hua",
      issue_id: id ?? undefined,
    };
  }

  // ---- GATE 3: 4/24h cap (sirf counted automation types pe; housekeeping exempt) ----
  let cap: BrainRunResult["cap"] = null;
  if (isCountedAutomationType(plan.jobType)) {
    try {
      const c = await checkCap(sb, userId);
      cap = {
        used: c.used,
        limit: c.limit,
        remaining: c.remaining,
        resets_at: c.resets_at,
      };
      if (!c.ok) {
        decision.chosen_action = "wait";
        decision.rationale += ` [cap gate: ${c.error.slice(0, 160)}]`;
        await logActivity(sb, userId, "brain_cap", `Brain: cap full — ${plan.jobType} enqueue roka.`);
        return {
          verified: true,
          finalAction: "wait",
          note: "cap full — slot khulne pe retry",
          cap,
        };
      }
    } catch (e) {
      throw new Error(
        `cap check fail: ${String((e as Error)?.message ?? e).slice(0, 120)}`
      );
    }
  }

  // ---- GATE 4: enqueue (directive payload — scripted taps NAHI) ----
  const payload: Record<string, unknown> = {
    directive: decision.directive ?? {
      goal: plan.directiveGoal,
      constraints: [],
      context: {},
    },
    brain_decision: smallDecision(decision),
    pipeline_request_id: opts.pipeline_request_id ?? null,
    campaign_slug:
      typeof campaignInput?.id === "string" ? campaignInput.id : undefined,
  };
  const res = await createAutomationJob(sb, userId, deviceId, plan.jobType, payload, {
    idempotency_key: opts.pipeline_request_id
      ? `brain:${opts.pipeline_request_id}`
      : `brain:${randomUUID()}`,
  });
  if (!res.ok) {
    throw new Error(`enqueue fail (${res.code}): ${res.error.slice(0, 160)}`);
  }
  // ---- VERIFY: job sach me bana? (sirf "action chala" kaafi nahi) ----
  const verified = Boolean(res.job_id);
  if (!verified) {
    throw new Error("enqueue ne job_id nahi diya — verify fail");
  }
  await logActivity(
    sb,
    userId,
    "brain_enqueue",
    `Brain: ${plan.jobType} job ${res.job_id.slice(0, 8)}… queued (goal: ${decision.goal}).`
  );
  return {
    verified,
    finalAction: "enqueue_phone_job",
    note: `job ${res.job_id.slice(0, 8)}… queued${res.deduped ? " (deduped)" : ""}`,
    job_id: res.job_id,
    cap,
  };
}

/* ---------------- DRY-RUN gates (read-only: mastery → veto → cap) ----------------
 * dry_run me act() ke side effects (enqueue/issue/memory) skip hote hain, lekin
 * gates evaluate hone chahiye — warna decision misleading hota. Ye sirf padhta
 * hai, kuch likhta nahi.
 */
async function gatesDryRun(
  sb: any,
  opts: BrainOptions,
  _p: Perception,
  decision: Decision
): Promise<{ cap: BrainRunResult["cap"]; errors: string[] }> {
  const errors: string[] = [];
  const plan = goalPlan((opts.goal ?? "clip_post").trim() || "clip_post");
  const userId = opts.userId;

  if (decision.chosen_action !== "enqueue_phone_job" || !plan) {
    return { cap: null, errors };
  }

  // GATE 1: mastery (read-only)
  try {
    const mastery = await getSkillMastery(sb, userId, decision.skill);
    if (!mastery.autonomous) {
      decision.chosen_action = "needs_review";
      decision.rationale += ` [dry-run mastery gate: ${mastery.note}]`;
      return { cap: null, errors };
    }
  } catch (e) {
    errors.push(`dry-run mastery read fail: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    decision.chosen_action = "needs_review";
    decision.rationale += " [dry-run: mastery read fail → fail-closed]";
    return { cap: null, errors };
  }

  // GATE 2: compliance veto (pure evaluate — koi side effect nahi)
  const campaignInput = opts.campaign
    ? {
        id: typeof opts.campaign.id === "string" ? opts.campaign.id : undefined,
        name: (opts.campaign.name as string | null) ?? null,
        requirements: (opts.campaign.requirements as string | null) ?? null,
        caption_template: (opts.campaign.caption_template as string | null) ?? null,
        hashtags: (opts.campaign.hashtags as string | null) ?? null,
        brief_url: (opts.campaign.brief_url as string | null) ?? null,
        campaign_url: (opts.campaign.campaign_url as string | null) ?? null,
        submitted: opts.campaign.submitted === true,
        notes:
          opts.campaign.notes && typeof opts.campaign.notes === "object"
            ? (opts.campaign.notes as Record<string, unknown>)
            : null,
      }
    : undefined;
  const vetoRes = SKILLS["compliance-guard"].evaluate({
    campaign: campaignInput,
    job_kind: plan.jobKind,
  });
  if (vetoRes.veto) {
    decision.chosen_action = "needs_review";
    decision.rationale += ` [dry-run COMPLIANCE VETO: ${vetoRes.reasons.join(" | ").slice(0, 300)} — live run me HIGH issue + needs_review]`;
    return { cap: null, errors };
  }

  // GATE 3: cap (read-only)
  let cap: BrainRunResult["cap"] = null;
  if (isCountedAutomationType(plan.jobType)) {
    try {
      const c = await checkCap(sb, userId);
      cap = { used: c.used, limit: c.limit, remaining: c.remaining, resets_at: c.resets_at };
      if (!c.ok) {
        decision.chosen_action = "wait";
        decision.rationale += ` [dry-run cap gate: ${c.error.slice(0, 160)}]`;
      }
    } catch (e) {
      errors.push(`dry-run cap read fail: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      decision.chosen_action = "needs_review";
      decision.rationale += " [dry-run: cap read fail → fail-closed]";
    }
  }
  return { cap, errors };
}

/* ---------------- runBrain: poora loop ---------------- */

export async function runBrain(sb: any, opts: BrainOptions): Promise<BrainRunResult> {
  const errors: string[] = [];

  // PERCEIVE
  const p = await perceive(sb, opts.userId, opts.deviceId);

  // UNDERSTAND + REASON
  const decision = reason(p, opts);

  // dry_run → sirf decision, koi side effect nahi (no enqueue, no issue, no memory).
  // Gates (mastery/veto/cap) READ-ONLY evaluate hote hain taaki dry-run decision
  // honest ho — bina gates ke "enqueue_phone_job" misleading hota.
  if (opts.dryRun) {
    const g = await gatesDryRun(sb, opts, p, decision);
    decision.rationale += ` [dry_run: gates evaluated, koi side effect nahi]`;
    return {
      ok: true,
      decision,
      cap: g.cap,
      verified: false,
      attempts: 0,
      errors: g.errors,
    };
  }

  // ACT + VERIFY + ADAPT (3 attempts max, har retry me naya reasoning)
  let attempts = 0;
  let lastOutcome: ActOutcome | null = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      lastOutcome = await act(sb, opts, p, decision);
      break; // success (ya controlled needs_review/wait — wo fail nahi)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      errors.push(`attempt ${attempts}: ${msg}`);
      // ADAPT: skill lessons se naya reasoning
      const relevant = p.lessons.filter(
        (l) => l.skill === decision.skill && l.summary
      );
      const lessonHint = relevant[0]?.summary;
      decision.rationale +=
        ` [adapt attempt ${attempts} fail: ${msg}` +
        (lessonHint ? ` | lesson: ${lessonHint.slice(0, 120)}` : "") +
        "]";
      decision.confidence = Math.max(0.1, decision.confidence - 0.2);
      decision.fallback =
        lessonHint ??
        "agla attempt naye reasoning ke saath, phir escalate";
      if (attempts >= MAX_ATTEMPTS) {
        // ESCALATE: severity=high issue + root-cause hypothesis
        const hypothesis =
          errors.length >= 2 && errors[0] === errors[1]
            ? `deterministic failure — ${errors[0]} (har attempt me same error)`
            : `flaky/transient ya multi-cause — ${errors.join(" || ").slice(0, 300)}`;
        const issueId = await fileAgentIssue(
          sb,
          opts.userId,
          "server-brain",
          "high",
          `Brain ${MAX_ATTEMPTS} attempts me fail: ${decision.goal}`,
          {
            errors,
            skill: decision.skill,
            device_id: opts.deviceId,
            pipeline_request_id: opts.pipeline_request_id ?? null,
          },
          hypothesis
        );
        decision.chosen_action = "needs_review";
        lastOutcome = {
          verified: false,
          finalAction: "needs_review",
          note: `3 attempts fail — escalated (issue ${issueId?.slice(0, 8) ?? "?" }…)`,
          issue_id: issueId ?? undefined,
        };
      }
      // warna loop dobara — act() naye rationale ke saath retry
    }
  }

  const outcome = lastOutcome ?? {
    verified: false,
    finalAction: decision.chosen_action,
    note: "koi act outcome nahi",
  };

  // Har decision persist hoti hai (brain_decision memory)
  await persistDecision(sb, opts.userId, decision, p, {
    job_id: outcome.job_id ?? null,
    issue_id: outcome.issue_id ?? null,
    verified: outcome.verified,
    attempts,
    note: outcome.note,
  });

  return {
    ok: outcome.verified,
    decision,
    job_id: outcome.job_id,
    issue_id: outcome.issue_id,
    cap: outcome.cap ?? null,
    verified: outcome.verified,
    attempts,
    errors,
  };
}
