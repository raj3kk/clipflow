/**
 * ClipFlow v2 automation workflow — server step-builder, phone executor.
 *
 * Phone ka JobEngine generic hai (download/navigate/click/type/upload/
 * wait_url/wait_text/eval/extract/assert/screenshot). ASLI workflow yahan
 * banta hai: IG Reel upload (Original = bina crop) → link nikalo →
 * live reel double-check → Whop pe submit (30 min ke andar) → submissions
 * verify → screenshot proof.
 *
 * User spec (2026-09-18):
 *  - campaign requirement ke hisab se ready clip (video_url) + caption /
 *    hashtags + Whop submit URL = "clip package" (website pe set hota hai)
 *  - video bina crop ke upload ho (Original aspect)
 *  - IG link nikal ke Whop pe submit, IG upload ke 30 min ke andar
 *    (warna Whop reject kar deta hai)
 *  - submit ke baad Whop submissions me jaake confirm karo
 *  - har stage ka screenshot proof
 */

export interface ClipPackage {
  video_url: string;
  caption: string;
  whop_submit_url: string;
}

export function validateClipPackage(p: unknown): {
  ok: boolean;
  error?: string;
  pkg?: ClipPackage;
} {
  if (typeof p !== "object" || p === null) {
    return { ok: false, error: "clip package chahiye: video_url, caption, whop_submit_url." };
  }
  const o = p as Record<string, unknown>;
  const video_url = String(o.video_url ?? "").trim();
  const caption = String(o.caption ?? "").trim();
  const whop_submit_url = String(
    o.whop_submit_url ?? "https://whop.com/content-rewards/"
  ).trim();
  if (!/^https?:\/\/.+/.test(video_url)) {
    return { ok: false, error: "video_url sahi nahi hai (direct MP4 link do)." };
  }
  if (!caption) {
    return { ok: false, error: "caption khaali hai." };
  }
  if (!/^https?:\/\/.+/.test(whop_submit_url)) {
    return { ok: false, error: "whop_submit_url sahi nahi hai." };
  }
  return { ok: true, pkg: { video_url, caption, whop_submit_url } };
}

type Step = Record<string, unknown>;

/**
 * Poora automation workflow — steps ka array.
 * Har step me "phase" sirf readability ke liye hai (phone ignore karta hai).
 */
export function buildClipSteps(pkg: ClipPackage): Step[] {
  const captionQ = JSON.stringify(pkg.caption); // JS me safe embed
  const whopUrl = pkg.whop_submit_url;

  const steps: Step[] = [
    // ---------- Phase 1: clip download ----------
    {
      phase: "download",
      action: "download",
      url: pkg.video_url,
      as: "reel.mp4",
    },

    // ---------- Phase 2: Instagram upload (Original = NO CROP) ----------
    { phase: "ig-open", action: "navigate", url: "https://www.instagram.com/" },
    // login check — app me IG login nahi to saaf error
    {
      phase: "ig-login-check",
      action: "assert",
      js: "location.href.indexOf('/accounts/login')===-1",
      message: "Instagram login nahi hai — phone app me Instagram login karo",
    },
    // notification popup aaye to hatao (best-effort)
    {
      phase: "ig-popup",
      action: "eval",
      optional: true,
      js: "(function(){var b=[...document.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='Not Now');if(b)b.click();return !!b;})()",
    },
    // action-block ka pehle se pata lag jaye
    {
      phase: "ig-block-check",
      action: "assert",
      js: "!/try again later|action blocked|we restrict/i.test(document.body?document.body.innerText:'')",
      message:
        "Instagram action blocked lag raha hai ('Try again later') — 24-48h ruko",
    },
    { phase: "ig-create-wait", action: "wait_text", text: "Create", timeout: 60000 },
    { phase: "ig-create", action: "click", by: "text", value: "Create" },
    // file chooser phone khud handle karta hai (reel.mp4)
    {
      phase: "ig-upload",
      action: "upload",
      by: "text",
      value: "Select from computer",
      file: "reel.mp4",
    },
    // crop screen — ORIGINAL select (bina crop)
    { phase: "ig-crop", action: "wait_text", text: "Crop", timeout: 90000 },
    { phase: "ig-original", action: "click", by: "text", value: "Original" },
    { phase: "ig-proof-crop", action: "screenshot", as: "proof_crop_original.png" },
    { phase: "ig-next1", action: "click", by: "text", value: "Next" },
    // beech me trim/cover screen aaye to ek aur Next (best-effort)
    {
      phase: "ig-next2",
      action: "eval",
      js: "(function(){if(document.body.innerText.indexOf('Write a caption')===-1){var b=[...document.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='Next');if(b){b.click();return 'clicked';}}return 'already';})()",
    },
    { phase: "ig-caption-wait", action: "wait_text", text: "Write a caption", timeout: 90000 },
    {
      phase: "ig-caption",
      action: "eval",
      js: `(function(){var el=document.querySelector('[aria-label^="Write a caption"]');if(!el)return 'no-box';el.focus();try{document.execCommand('selectAll',false,null)}catch(e){}var ok=false;try{ok=document.execCommand('insertText',false,${captionQ})}catch(e){}el.dispatchEvent(new Event('input',{bubbles:true}));return ok?'typed':'fail';})()`,
    },
    { phase: "ig-share", action: "click", by: "text", value: "Share" },
    // upload processing me time lagta hai
    { phase: "ig-shared", action: "wait_text", text: "shared", timeout: 300000 },
    {
      phase: "ig-view",
      action: "eval",
      optional: true,
      js: "(function(){var b=[...document.querySelectorAll('button,a')].find(e=>(e.innerText||'').trim()==='View');if(b){b.click();return 'clicked'}return 'auto-nav';})()",
    },
    { phase: "ig-reel-url", action: "wait_url", contains: "/reel/", timeout: 90000 },
    { phase: "ig-extract", action: "extract", as: "reel_url", js: "location.href" },
    { phase: "ig-time", action: "extract", as: "t_upload_ms", js: "Date.now().toString()" },
    { phase: "ig-proof", action: "screenshot", as: "proof_reel_posted.png" },

    // ---------- Phase 3: DOUBLE-CHECK live reel (crop/thik hai?) ----------
    { phase: "verify-open", action: "navigate", url: "{{reel_url}}" },
    {
      phase: "verify-video",
      action: "assert",
      js: "!!document.querySelector('video')",
      message: "Live reel page pe video nahi mila — upload fail ho sakta hai",
    },
    { phase: "verify-shot", action: "screenshot", as: "proof_reel_live.png" },

    // ---------- Phase 4: Whop submit (30 min ke andar) ----------
    { phase: "whop-open", action: "navigate", url: whopUrl },
    { phase: "whop-wait", action: "wait_text", text: "Submit", timeout: 90000 },
    // v1 me PROVEN selector: URL field me reel link paste
    {
      phase: "whop-paste",
      action: "eval",
      js: "(function(){var fs=[...document.querySelectorAll('input[type=\"url\"],input[placeholder*=\"nstagram\"],input[placeholder*=\"ink\"]')];var f=fs[0];if(!f)return 'no-field';f.focus();try{document.execCommand('selectAll',false,null)}catch(e){}document.execCommand('insertText',false,'{{reel_url}}');f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('change',{bubbles:true}));return 'pasted';})()",
    },
    { phase: "whop-submit", action: "click", by: "text", value: "Submit" },
    { phase: "whop-confirm", action: "wait_text", text: "Clip submitted", timeout: 90000 },
    {
      phase: "whop-assert",
      action: "assert",
      js: "document.body.innerText.indexOf('Clip submitted')!==-1",
      message: "Whop pe 'Clip submitted' confirmation nahi mila",
    },
    { phase: "whop-time", action: "extract", as: "t_submit_ms", js: "Date.now().toString()" },
    { phase: "whop-proof", action: "screenshot", as: "proof_whop_submitted.png" },

    // ---------- Phase 5: Whop submissions me jaake verify (best-effort) ----------
    { phase: "sub-open", action: "navigate", url: "https://whop.com/content-rewards/", optional: true },
    { phase: "sub-wait", action: "wait_text", text: "Pending", timeout: 60000, optional: true },
    { phase: "sub-shot", action: "screenshot", as: "proof_whop_dashboard.png", optional: true },

    // ---------- Phase 6: 30-min guard (IG upload → Whop submit) ----------
    {
      phase: "guard-30min",
      action: "assert",
      js: "(parseInt('{{t_submit_ms}}',10)-parseInt('{{t_upload_ms}}',10)) < 1800000",
      message:
        "IG upload se Whop submit me 30 min se zyada lag gaya — Whop reject kar sakta hai. Dobara submit karo.",
    },
  ];

  return steps;
}

/**
 * join_campaign job payload (Round-7, 2026-09-19).
 *
 * Phone app ka JobEngine is type ke liye DEDICATED handler chalata hai
 * (engine.runJoinCampaign) — generic steps array nahi chahiye. Phone apne
 * logged-in Whop WebView me campaign_url kholta hai, Join button dabata hai,
 * confirmation ka wait karta hai, aur result.vars me join_status bhejta hai:
 *   joined | already_joined | needs_user | failed
 * Result route (jobs/[id]/result) usi ke hisab se campaigns.joined /
 * campaigns.join_status update karta hai.
 */
export function buildJoinCampaignPayload(
  campaignSlug: string,
  campaignUrl: string
): Record<string, unknown> {
  return {
    workflow: "v2-join-campaign",
    workflow_version: 1,
    campaign_slug: campaignSlug,
    campaign_url: campaignUrl,
  };
}

/**
 * verify_campaigns job payload (Round-7b, 2026-09-19).
 *
 * Server ke paas Whop login NAHI hai — isliye campaign ka FINAL chunav phone
 * karta hai. Server sirf top candidates bhejta hai (paisa-ranked); phone apne
 * logged-in Whop WebView me har candidate kholta hai aur check karta hai:
 * joined? requirements kya hain? official video links kaunsi? pehle submit
 * hua? Phir best-fit choose karke (zaroorat ho to join karke) result bhejta hai.
 *
 * Phone ka dedicated handler: JobEngine.runVerifyCampaigns.
 * Result vars: verify_status = verified | needs_user | failed,
 *   chosen_campaign_id, verify_results (per-candidate JSON), verify_detail.
 * Result route usi ke hisab se campaigns.notes me verified_* data + join_status
 * update karta hai — planner agli tick me verified campaign pe clip banata hai.
 */
export interface VerifyCandidate {
  campaign_id: string;
  name: string;
  campaign_url: string;
  payout_per_1k_usd: number | null;
}

export function buildVerifyCampaignsPayload(
  candidates: VerifyCandidate[]
): Record<string, unknown> {
  return {
    workflow: "v2-verify-campaigns",
    workflow_version: 1,
    candidates: candidates.map((c) => ({
      campaign_id: c.campaign_id,
      name: c.name,
      campaign_url: c.campaign_url,
      payout_per_1k_usd: c.payout_per_1k_usd ?? null,
    })),
  };
}

/** Job payload: phone JobEngine seedha chala leta hai. */
export function buildAutomationPayload(
  pkg: ClipPackage,
  opts?: { campaign_slug?: string }
): Record<string, unknown> {
  return {
    workflow: "v2-clip-post",
    workflow_version: 2,
    video_url: pkg.video_url,
    caption: pkg.caption,
    whop_submit_url: pkg.whop_submit_url,
    // campaign dedup ke liye (v2_submissions.unique(user_id, campaign_slug))
    campaign_slug: opts?.campaign_slug ?? null,
    steps: buildClipSteps(pkg),
  };
}

// deploy-trigger: round-7b verify protocol live
