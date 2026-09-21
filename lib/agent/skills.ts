/**
 * ClipFlow server-brain ke 6 specialist skills.
 *
 * Har skill ek versioned object hai: metadata + pure evaluate() validator.
 * compliance-guard HARD VETO rakhta hai — uska veto FINAL hai, brain usko
 * override NAHI kar sakta, sirf escalate kar sakta hai (agent_issue).
 *
 * Mastery agent_skills table me per (user_id, skill_key) track hoti hai.
 * getSkillMastery() fail-closed gate hai: mastery < 0.6 ya needs_review
 * hone pe autonomous:false — brain ko human review me jana hi padega.
 */

export type SkillKey =
  | "campaign-scout"
  | "join-navigator"
  | "compliance-guard"
  | "render-director"
  | "upload-coordinator"
  | "submit-verifier"
  | "recovery-specialist";

/** Skill evaluate() ko milne wala input — campaign candidate + job context. */
export interface SkillEvalInput {
  campaign?: {
    id?: string;
    name?: string | null;
    requirements?: string | null;
    caption_template?: string | null;
    hashtags?: string | null;
    brief_url?: string | null;
    campaign_url?: string | null;
    /** pehle submit ho chuka? (no-repeat rule) */
    submitted?: boolean;
    notes?: Record<string, unknown> | null;
  };
  /** 'clip' | 'join' | 'discover' | 'verify' | 'recover' | 'post' */
  job_kind?: string;
  context?: Record<string, unknown>;
}

export interface SkillEvalResult {
  pass: boolean;
  /** sirf compliance-guard set karta hai — veto FINAL hai. */
  veto?: boolean;
  reasons: string[];
}

export interface Skill {
  key: SkillKey;
  version: number;
  description: string;
  preconditions: string[];
  masteryCriteria: string[];
  evaluate(input: SkillEvalInput): SkillEvalResult;
}

/** Clip/post-type job? (compliance gates isi pe lagte hain) */
function isClipKind(kind: string | undefined): boolean {
  return kind === "clip" || kind === "post" || kind === "automation";
}

function notesOf(
  input: SkillEvalInput
): Record<string, unknown> {
  const n = input.campaign?.notes;
  return n && typeof n === "object" ? (n as Record<string, unknown>) : {};
}

function verifiedVideoLink(notes: Record<string, unknown>): string | null {
  const v = notes.verified_video_links;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return (v[0] as string).trim() || null;
  }
  return null;
}

/** Payment-looking join signals (select-campaign classify() ka mirror). */
const PAYMENT_RE =
  /\$\s*\d+\s*(\/\s*(mo|month)|per\s*month)|\/mo\b|paid membership|subscription required|join_paid/i;

const LOGIN_RE = /\blog ?in\b|\bsign ?in\b|login required|sign-in required/i;

const UGC_RE =
  /original\s+(video|content)|film\s+yourself|record\s+yourself|face[\s-]?cam|talking[\s-]?head/i;

/** Placeholder caption — exact/normalized nahi hai. */
const CAPTION_PLACEHOLDER_RE = /\[.*(insert|your|here|brand|tag|hashtag).*\]/i;

export const SKILLS: Record<SkillKey, Skill> = {
  /* ------------------------------------------------------------------ */
  "campaign-scout": {
    key: "campaign-scout",
    version: 1,
    description:
      "Campaign discovery aur ranking — eligible pool se payout-weighted pick, " +
      "no-repeat (submitted exclude) aur notes.eligible=false exclusion ke saath. " +
      "Payout mechanics (2026-09-21 Whop docs research): min payout = minimum-views " +
      "gate (views >= min_payout/rate x 1000 tabhi review), max payout = per-video " +
      "earning cap, flat fee bonus wale campaigns me chhote views bhi faydemand. " +
      "Budget dry-up stop rule: remaining budget nazdeek-khaali dikhe to posting roko " +
      "(late-verifying views unpaid reh jate hain). Brief doc brands kabhi bhi update " +
      "kar sakte hain — har run se pehle live brief dobara padho, cached brief pe " +
      "bharosa nahi. CR ToS (2026-09-21): payout WHOP CREDITS me, first-come-first-served " +
      "(cutoff ke baad ke views ka paisa nahi); content types me 'other' bhi hota hai — " +
      "sirf 'clipping' pick karo, 'ugc'/'other' veto.",
    preconditions: [
      "active campaigns ka pool load hona chahiye",
      "submitted-campaign exclusion data available hona chahiye (fail-closed: load na ho to koi pick nahi)",
      "har run pe live brief re-read (cached brief stale ho sakta hai)",
    ],
    masteryCriteria: [
      "7 din me 10+ picks, koi submitted campaign dobara pick nahi",
      "koi ineligible (notes.eligible=false) campaign pick nahi",
      "har pick me payout/budget weighting ka audit trail",
      "budget dry-up pe posting roki (khaali pool me post nahi)",
      "har run pe live brief re-read, stale caption se reject nahi",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      const pool = ctx.pool_size;
      if (typeof pool === "number" && pool <= 0) {
        reasons.push("eligible pool khaali hai — koi pick nahi ho sakta");
      }
      if (ctx.exclusion_loaded === false) {
        reasons.push(
          "submitted-exclusion data load nahi hui — fail closed, koi pick nahi"
        );
      }
      return { pass: reasons.length === 0, reasons };
    },
  },

  /* ------------------------------------------------------------------ */
  "join-navigator": {
    key: "join-navigator",
    version: 1,
    description:
      "Whop/Content Rewards join-flow navigator (2026-09-21 video training) — " +
      "join-type classify karo (A: free-checkout / B: direct-whop / C: " +
      "application-required), free checkout pe Continue CLICK karke joined " +
      "verify karo, semantic navigation (koi coordinate/blind tap nahi). " +
      "Campaign type check: Clipping (brand ke existing videos se short clips) " +
      "pe hi automation — 'UGC'/'original content' type label dikhe to compliance " +
      "veto (requirements padhne se pehle).",
    preconditions: [
      "campaign card / whop page ka live page-state perceive hua hona chahiye",
      "join directive me campaign target (whop_url/campaign_url) hona chahiye",
      "campaign type label check (Clipping vs UGC) — UGC pe veto",
    ],
    masteryCriteria: [
      "10 joins me join-type classification sahi ho",
      "koi join 'click ho gaya' bina verify claim nahi ho",
      "koi paid join auto-complete nahi ho",
      "koi coordinate-based tap nahi ho",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      const joinType = String(ctx.join_type ?? "").toUpperCase();
      const kind = input.job_kind ?? "";

      // 1. Join-type classify hona chahiye (A/B/C) — bina classify andha join nahi
      if (kind === "join" && !["A", "B", "C"].includes(joinType)) {
        reasons.push(
          "join_type classify nahi hua (A=free-checkout / B=direct-whop / " +
            "C=application) — bina classify andha join nahi"
        );
      }

      // 2. Type A (free-checkout): Continue CLICK + joined verification mandatory
      if (joinType === "A") {
        if (ctx.checkout_continue_clicked !== true) {
          reasons.push(
            "free checkout pe Continue CLICK nahi hua — page kholna kaafi nahi, " +
            "click ke bina join complete nahi hota (video rule)"
          );
        }
        if (ctx.joined_verified !== true) {
          reasons.push(
            "joined state verify nahi hua (community sidebar / welcome " +
              "notification / Content Rewards page) — 'click ho gaya' kaafi nahi"
          );
        }
        if (ctx.checkout_price_paid === true) {
          reasons.push("checkout me payment hua — auto-pay KABHI nahi (hard veto)");
        }
      }

      // 3. Type C (application-required): manual hai — joined pretend mat karo
      if (joinType === "C" && ctx.application_completed === true) {
        reasons.push(
          "application-required campaign ko joined pretend nahi kar sakte — needs_user"
        );
      }

      // 4. Coordinate/blind tap hua to rule toota
      if (ctx.used_coordinates === true) {
        reasons.push("coordinate-based tap hua — semantic-only rule toota");
      }

      return {
        pass: reasons.length === 0,
        veto: ctx.checkout_price_paid === true,
        reasons,
      };
    },
  },

  /* ------------------------------------------------------------------ */
  "compliance-guard": {
    key: "compliance-guard",
    version: 1,
    description:
      "Fail-closed compliance gates — HARD VETO. Ye kabhi bypass nahi hota: " +
      "veto aaya to brain sirf escalate karega (agent_issue), enqueue kabhi nahi. " +
      "HARD boundary (Whop clipping Terms): fake views, bots, artificial engagement, " +
      "stolen content, impersonation, copyright violation, campaign material misuse " +
      "-> account suspension/removal. Payout sirf valid traffic pe. Koi view-boosting " +
      "shortcut kabhi nahi. CR ToS (2026-09-21, official): (1) FTC disclosure MANDATORY " +
      "— har post me #Sponsored ya #[Brand]Ad 'more' fold se PEHLE (caption me jodo); " +
      "(2) Whop ke bahar koi compensation deal = suspension/termination; " +
      "(3) violation pe credits ka WITHHOLDING/CLAWBACK + naya account ban nahi; " +
      "(4) Content Rewards 18+ only; (5) Whop pe scraping/automated harvesting mana " +
      "hai — sirf user ka real app WebView chalao; (6) termination pe turant posting " +
      "band + content remove karo.",
    preconditions: [
      "campaign candidate ka requirements + caption_template + brief/notes data hona chahiye",
      "clip/post-type enqueue se PEHLE mandatory run",
    ],
    masteryCriteria: [
      "koi payment-looking join auto-enqueue nahi",
      "koi bina-exact-caption / bina-usable-brief clip enqueue nahi",
      "koi original-UGC campaign automation me nahi gaya",
      "koi fake-views/bots/artificial-engagement attempt kabhi nahi",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const c = input.campaign;
      const kind = input.job_kind ?? "";
      if (!c) {
        return {
          pass: false,
          veto: true,
          reasons: [
            "campaign candidate hi nahi diya — andhere me koi enqueue nahi",
          ],
        };
      }
      const req = (c.requirements ?? "").toLowerCase();
      const nameL = (c.name ?? "").toLowerCase();
      const notes = notesOf(input);
      const clipKind = isClipKind(kind);

      // 1. Campaign pehle hi submit ho chuka — permanent no-repeat rule
      if (c.submitted === true) {
        reasons.push(
          "ye campaign pehle hi submit ho chuka hai — no-repeat rule (veto)"
        );
      }

      // 2. Payment-looking join — user khud decide karega, auto-pay KABHI nahi
      if (
        notes.join_paid === true ||
        PAYMENT_RE.test(req + " " + nameL)
      ) {
        reasons.push(
          "payment-looking join (price/$/mo/subscription signal) — auto-pay bilkul nahi, user decide karega (veto)"
        );
      }

      // 3. Login required — NOTE: locked Content Rewards unlock ek valid
      // route hai, wo "login required" NAHI hai (wo veto nahi karta).
      if (LOGIN_RE.test(req + " " + nameL)) {
        reasons.push(
          "login required — phone ke WebView session se bahar ka kaam, user ka step (veto)"
        );
      }

      // 4. Missing exact caption (sirf clip/post kinds pe) — galat caption = reject risk
      if (clipKind) {
        const cap = (c.caption_template ?? "").trim();
        if (cap.length < 20 || CAPTION_PLACEHOLDER_RE.test(cap)) {
          reasons.push(
            "exact/normalized caption nahi hai (bahut chhota ya placeholder) — galat caption = reject risk (veto)"
          );
        }
      }

      // 5. Unusable / unverified brief asset (sirf clip/post kinds pe)
      if (clipKind) {
        const asset =
          verifiedVideoLink(notes) || (c.brief_url ?? "").trim();
        if (!asset) {
          reasons.push(
            "koi usable/unverified brief asset nahi — bina verified video ke clip nahi ban sakta (veto)"
          );
        }
      }

      // 6. Original UGC requirement — automation se compliant clip nahi banega
      if (UGC_RE.test(req)) {
        reasons.push(
          "original UGC (face-cam/talking-head/khud record karo) required — automation se compliant nahi (veto)"
        );
      }

      // 7. Required bio link unresolved — IG app me manual user step hai
      const bioLink = notes.required_bio_link;
      if (
        typeof bioLink === "string" &&
        bioLink.trim().length > 0 &&
        notes.bio_link_set !== true
      ) {
        reasons.push(
          `required bio link set nahi hai (${bioLink.slice(0, 60)}) — user ka manual step (veto)`
        );
      }

      return { pass: reasons.length === 0, veto: reasons.length > 0, reasons };
    },
  },

  /* ------------------------------------------------------------------ */
  "render-director": {
    key: "render-director",
    version: 1,
    description:
      "VM clip_factory ke liye clip spec — source asset, duration, hook/caption " +
      "safe-zones (Original 9:16) ke saath directive banata hai. Duplicate-clip " +
      "rule: doosre clipper ka same/near-duplicate pehle submit ho chuka ho to " +
      "reject risk — har post me transformation (unique caption, alag trim, alag " +
      "opening frame), pool ke sab clippers se distinct.",
    preconditions: [
      "verified video asset URL hona chahiye",
      "campaign ka min/max seconds pata hona chahiye",
    ],
    masteryCriteria: [
      "har spec me hook ≥10% below top aur captions bottom UI zone se upar",
      "duration campaign min/max ke andar",
      "koi spec bina verified asset ke nahi",
      "har clip me transformation (duplicate-submission reject nahi)",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      const videoUrl =
        typeof ctx.video_url === "string" ? ctx.video_url.trim() : "";
      if (!videoUrl) reasons.push("clip spec me video_url missing hai");
      const dur = Number(ctx.duration_s);
      const minS = Number(ctx.min_seconds ?? 0);
      const maxS = Number(ctx.max_seconds ?? 0);
      if (!Number.isFinite(dur) || dur <= 0) {
        reasons.push("duration_s valid nahi hai");
      } else {
        if (minS > 0 && dur < minS)
          reasons.push(`duration ${dur}s campaign min ${minS}s se kam hai`);
        if (maxS > 0 && dur > maxS)
          reasons.push(`duration ${dur}s campaign max ${maxS}s se zyada hai`);
      }
      const hookPct = Number(ctx.hook_top_pct);
      if (Number.isFinite(hookPct) && hookPct < 10) {
        reasons.push(
          `hook top se ${hookPct}% pe hai — locked rule: ≥10% neeche hona chahiye`
        );
      }
      return { pass: reasons.length === 0, reasons };
    },
  },

  /* ------------------------------------------------------------------ */
  "upload-coordinator": {
    key: "upload-coordinator",
    version: 1,
    description:
      "IG upload directives — Original 9:16, hook ≥10% below top, captions " +
      "bottom UI zone se upar, aur live-Reel frame verification ke baad hi submit.",
    preconditions: [
      "render hua 9:16 clip file ready hona chahiye",
      "exact caption + required @tag/hashtags pata hone chahiye",
    ],
    masteryCriteria: [
      "koi cropped/zoomed upload nahi — sab Original aspect",
      "har upload ke baad live-Reel frame checks (~1s/7s/15s/25s)",
      "post→submit 30 min ke andar",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      if (ctx.aspect !== "9:16" && ctx.aspect !== "original") {
        reasons.push("upload aspect Original 9:16 hona chahiye");
      }
      if (ctx.frame_checks_done !== true) {
        reasons.push(
          "live-Reel frame checks (~1s/7s/15s/25s) verify nahi hue — submit se pehle mandatory"
        );
      }
      if (ctx.post_submit_gap_min !== undefined) {
        const gap = Number(ctx.post_submit_gap_min);
        if (Number.isFinite(gap) && gap > 30) {
          reasons.push(
            `post→submit gap ${gap} min hai — limit 30 min (locked rule)`
          );
        }
      }
      return { pass: reasons.length === 0, reasons };
    },
  },

  /* ------------------------------------------------------------------ */
  "submit-verifier": {
    key: "submit-verifier",
    version: 1,
    description:
      "Whop submit + live-Reel frame verification — post hua Reel kholke " +
      "frames check karo (~1s hook, 7s/15s/25s captions), phir hi submit. " +
      "Post se PEHLE verify karo ki posting account Whop se linked hai " +
      "(unlinked account = submission untrackable = reject). " +
      "CR ToS (2026-09-21, official): submission states Pending/Approved/Flagged/Rejected; " +
      "AI reviewer screen karta hai, brand ke 48h ke baad AUTO-APPROVE — lambi pending " +
      "stuck nahi, dobara submit mat karo. Payout Whop Credits me (withdraw $10 min + KYC). " +
      "CORRECTION: 24h/72h/7d screenshots koi official Whop rule NAHI — sirf brief " +
      "mange to rakho (campaign-level practice).",
    preconditions: [
      "IG pe Reel live post ho chuka hona chahiye (reel URL mile)",
      "Whop submit link/session available hona chahiye",
      "posting account Whop se linked verify (post se PEHLE)",
    ],
    masteryCriteria: [
      "submit sirf frame-verified Reel pe",
      "har submit ka screenshot proof",
      "submit ke baad v2_submissions me record",
      "koi submit unlinked account se nahi",
      "brief mange to analytics screenshots rakhe (official Whop rule nahi)",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      const reelUrl =
        typeof ctx.reel_url === "string" ? ctx.reel_url.trim() : "";
      if (!reelUrl) reasons.push("live Reel URL ke bina submit nahi");
      const frames = ctx.frames_checked;
      const need = ["1s", "7s", "15s", "25s"];
      const okFrames = Array.isArray(frames)
        ? need.every((f) => frames.includes(f))
        : false;
      if (!okFrames) {
        reasons.push(
          "frame checks adhoore hain — ~1s/7s/15s/25s sab verify hone chahiye"
        );
      }
      if (ctx.caption_mismatch === true) {
        reasons.push("burned-in caption campaign caption se match nahi hua");
      }
      return { pass: reasons.length === 0, reasons };
    },
  },

  /* ------------------------------------------------------------------ */
  "recovery-specialist": {
    key: "recovery-specialist",
    version: 1,
    description:
      "Stuck/failed run ka diagnosis — heartbeat, attempts, last error se " +
      "root cause nikalo; retry sirf naye reasoning ke saath, warna escalate.",
    preconditions: [
      "job ka status/attempts/last-heartbeat data available hona chahiye",
    ],
    masteryCriteria: [
      "har diagnosis me concrete root-cause hypothesis",
      "blind retry nahi — har retry me naya reasoning",
      "3 fail ke baad severity=high issue ke saath escalate",
    ],
    evaluate(input) {
      const reasons: string[] = [];
      const ctx = input.context ?? {};
      const job = ctx.job as Record<string, unknown> | undefined;
      if (!job || typeof job !== "object") {
        reasons.push("diagnosis ke liye job data hi nahi hai");
        return { pass: false, reasons };
      }
      if (!job.status) reasons.push("job.status missing hai");
      if (job.attempts === undefined || job.attempts === null)
        reasons.push("job.attempts missing hai");
      const hyp = ctx.root_cause_hypothesis;
      if (typeof hyp !== "string" || hyp.trim().length < 10) {
        reasons.push(
          "root-cause hypothesis missing/adhuri hai — bina iske escalate nahi"
        );
      }
      return { pass: reasons.length === 0, reasons };
    },
  },
};

export const SKILL_KEYS = Object.keys(SKILLS) as SkillKey[];

/** Mastery threshold — isse neeche (ya needs_review) = autonomous kaam band. */
export const MASTERY_THRESHOLD = 0.6;

export interface MasteryGate {
  /** false = fail-closed, brain ko needs_review me jana hoga */
  autonomous: boolean;
  mastery: number;
  needs_review: boolean;
  /** skill row abhi bani hi nahi (pehli baar) */
  missing: boolean;
  note: string;
}

/**
 * Skill mastery fail-closed gate.
 * Row missing ho ya mastery < 0.6 ho ya needs_review=true ho →
 * { autonomous: false } — brain autonomous enqueue NAHI karega.
 */
export async function getSkillMastery(
  sb: any,
  userId: string,
  skillKey: string
): Promise<MasteryGate> {
  try {
    const { data, error } = await sb
      .from("agent_skills")
      .select("mastery_score, needs_review")
      .eq("user_id", userId)
      .eq("skill_key", skillKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return {
        autonomous: false,
        mastery: 0,
        needs_review: false,
        missing: true,
        note:
          `agent_skills me '${skillKey}' ka row nahi hai — pehli baar hai, ` +
          `fail-closed: human review ke baad hi autonomous hoga.`,
      };
    }
    const mastery = Number(data.mastery_score ?? 0);
    const needsReview = data.needs_review === true;
    const autonomous =
      !needsReview && Number.isFinite(mastery) && mastery >= MASTERY_THRESHOLD;
    return {
      autonomous,
      mastery,
      needs_review: needsReview,
      missing: false,
      note: autonomous
        ? `mastery ${mastery.toFixed(2)} — autonomous OK`
        : needsReview
          ? `'${skillKey}' needs_review=true — fail-closed`
          : `mastery ${mastery.toFixed(2)} < ${MASTERY_THRESHOLD} — fail-closed`,
    };
  } catch (e) {
    // DB read fail = fail closed (kuch pata nahi = autonomous nahi)
    return {
      autonomous: false,
      mastery: 0,
      needs_review: false,
      missing: false,
      note:
        `mastery read fail ho gaya (${String((e as Error)?.message ?? e).slice(0, 80)}) ` +
        `— fail-closed: autonomous nahi.`,
    };
  }
}
