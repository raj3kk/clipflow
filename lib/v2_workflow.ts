/**
 * ClipFlow v2 automation workflow — server step-builder, phone executor.
 *
 * Phone ka JobEngine generic hai (download/navigate/click/type/upload/
 * wait_url/wait_text/eval/extract/assert/screenshot + p70 se `shot_upload`).
 * ASLI workflow yahan banta hai: IG Reel upload (Original = bina crop) →
 * link nikalo → live reel double-check → Whop pe submit (30 min ke andar) →
 * submissions verify → screenshot proof.
 *
 * v3 REBUILD (2026-09-22 — ground-zero reset):
 * Root cause (jobs 7dd86beb / d0733fdc, dono ig-caption-wait step 13/36 pe
 * mare): (1) server heartbeat live_steps/live_frame likhta hi nahi tha,
 * (2) phone mid-flow screenshots sirf job END pe bhejta tha. Isliye ab
 * OBSERVABILITY first-class hai: har critical transition pe `shot_upload`
 * (screenshot turant server pe — job ke end ka wait nahi) + heartbeat
 * frame/events → device_jobs.live_frame/live_steps.
 *
 * v3 design rules (JobEngine ke REAL behavior pe based — JobEngine.kt padh ke):
 *  - identify-then-act: har wait pehle screen identify karta hai. Shared
 *    IDENTIFY_EXPR har poll pe window.__acScreen = {name,url,title,signals,text}
 *    stash karta hai. wait_js SIRF target screen pe true.
 *  - JobEngine me `eval` ka JS-throw step fail NAHI karta (evaluateJavascript
 *    null → step pass; sirf `assert` throw karta hai, static message ke saath
 *    — message me {{var}} fill NAHI hota). Isliye timeout ke baad: optional
 *    wait → extract screen_seen (ASLI screen JSON vars me) → assert. Failure
 *    message static hai lekin vars.screen_seen_* me asli screen ka naam hota
 *    hai + shot_upload visual proof deta hai.
 *  - Blind Next loop KHATAM: intermediate screens (trim/cover/filter/music)
 *    naam se detect, har screen ka apna handler (exactly-1 advance button,
 *    4s throttle). UNKNOWN screen ya budget-exhaust → shot_upload + page-text
 *    excerpt ke saath fail-closed. Kabhi blind click nahi.
 *  - Caption detection — 3 independent signals (har poll pe __acScreen.signals
 *    me logged): (a) body text "Write a caption", (b) aria-label^="Write a
 *    caption" / textarea[aria-label*="caption"], (c) caption textbox ka JS
 *    handle (aria-label/placeholder me "caption").
 *  - Tolerant matching (case-insensitive regex, visible elements only);
 *    ambiguous (2+ matches) → fail-closed (failClosedClick helper).
 *  - Fail-closed campaign identity: Whop submit se pehle page ka campaign
 *    naam nikalo, payload ke campaign_name se match karo — mismatch → submit
 *    se pehle fail.
 *  - Canonical /reel/ URL + live verification BEFORE Whop submit: video
 *    element assert, 2 frames (shot_upload), URL me reel-id match.
 *  - Whop submit EXACT campaign URL pe + "Clip submitted" confirm + assert +
 *    shot_upload proof. 30-min guard rakha hai.
 *
 * NOTE (phone-app agent ke liye): ye workflow `shot_upload` action mangta hai
 * (contract: {action:"shot_upload", as:"<name>", phase, step?, msg?} →
 * POST /api/devices/jobs/:id/shot multipart {name, shot, step, phase, msg}).
 * plan-job route p70+ gate karta hai. workflow_version = 3.
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
 * Screen identifier — HAR poll pe chalta hai, window.__acScreen stash karta
 * hai. Har wait_js IIFE me sabse pehle `var s=<IDENTIFY_EXPR>;` lagao.
 * Returns {name, url, title, signals:{text,aria,handle}, text}.
 * Screen names: reel-page | caption | shared | sharing | create-dialog |
 * crop | trim | cover | filter | music | login | unknown
 */
const IDENTIFY_EXPR = `(function(){
var __vis=function(e){try{var r=e.getBoundingClientRect();return r.width>4&&r.height>4;}catch(x){return false;}};
var __btns=function(re){var o=[];try{document.querySelectorAll('button,[role="button"],a,input[type="submit"]').forEach(function(e){var t=((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.value||'')).trim();if(re.test(t)&&__vis(e))o.push(e);});}catch(x){}return o;};
var __b=(document.body?document.body.innerText:'')||'';
var __sig={text:/write a caption/i.test(__b),
aria:!!document.querySelector('[aria-label^="Write a caption"],textarea[aria-label*="caption" i]'),
handle:!!(function(){var cs=[...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')].filter(__vis);for(var i=0;i<cs.length;i++){var a=((cs[i].getAttribute('aria-label')||'')+' '+(cs[i].getAttribute('placeholder')||'')).toLowerCase();if(a.indexOf('caption')!==-1)return true;}return false;})()};
var __url=location.href||'';var __name='unknown';
if(/\\/reel\\/[^\\/\\?\\#]+/.test(__url))__name='reel-page';
else if(__sig.text||__sig.aria||__sig.handle)__name='caption';
else if(/your reel (was|has been) shared|reel shared/i.test(__b))__name='shared';
else if(/sharing|uploading your|processing/i.test(__b))__name='sharing';
else if(document.querySelector('input[type="file"]')||/select from (computer|device)/i.test(__b))__name='create-dialog';
else if(/original/i.test(__b)&&/(1:1|4:5|16:9)/.test(__b))__name='crop';
else if(/trim/i.test(__b)&&__btns(/done/i).length>0)__name='trim';
else if(/cover/i.test(__b)&&/select|choose/i.test(__b))__name='cover';
else if(/filter/i.test(__b)&&__btns(/^next$/i).length>0)__name='filter';
else if(/add music|select music/i.test(__b))__name='music';
else if(/\\/accounts\\/login/.test(__url))__name='login';
var __d={name:__name,url:__url,title:(document.title||'').slice(0,120),signals:__sig,text:__b.slice(0,400)};
window.__acScreen=__d;return __d;})()`;

/** Screenshot turant server bhejo (job ke end ka wait nahi). */
function shot(phase: string, as: string, msg?: string): Step {
  const s: Step = { phase, action: "shot_upload", as };
  if (msg) s.msg = msg;
  return s;
}

/**
 * identify-then-act wait: optional wait_js (target pe window.<flag>=true) →
 * extract screen_seen (ASLI screen JSON vars me — failure diagnosis ka source
 * of truth) → assert (static message, vars.screen_seen_* ki taraf ishara).
 * NOTE: assert ka message static hai (JobEngine message pe {{var}} fill nahi
 * karta) — isliye asli screen ka naam extract + shot me hota hai.
 */
function waitTarget(
  phase: string,
  flag: string,
  timeoutMs: number,
  condJs: string,
  failMsg: string,
  seenVar: string
): Step[] {
  return [
    { phase, action: "wait_js", optional: true, js: condJs, timeout: timeoutMs },
    {
      phase,
      action: "extract",
      as: seenVar,
      js: "JSON.stringify(window.__acScreen||{name:'unknown'})",
    },
    {
      phase,
      action: "assert",
      js: `window.${flag}===true`,
      message: `${failMsg} (asli screen vars.${seenVar} me dekho)`,
    },
  ];
}

/**
 * Fail-closed click: tolerant (case-insensitive regex, text+aria-label+value,
 * visible only). 0 matches → wait; EXACTLY 1 → click; 2+ → ambiguous flag →
 * assert fail (galat button kabhi nahi dabega).
 */
function failClosedClick(
  phase: string,
  key: string,
  label: string,
  regexSrc: string,
  timeoutMs: number,
  seenVar: string
): Step[] {
  const clickJs =
    `(function(){var s=${IDENTIFY_EXPR};` +
    `var CK='__acClicked_${key}';var AK='__acAmbig_${key}';` +
    `if(window[CK])return true;` +
    `var vis=function(e){try{var r=e.getBoundingClientRect();return r.width>4&&r.height>4;}catch(x){return false;}};` +
    `var c=[];try{document.querySelectorAll('button,[role="button"],a,input[type="submit"]').forEach(function(e){` +
    `var t=((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.value||'')).trim();` +
    `if(new RegExp(${JSON.stringify(regexSrc)},'i').test(t)&&vis(e))c.push(e);});}catch(x){}` +
    `if(c.length===1){c[0].scrollIntoView({block:'center'});c[0].click();window[CK]=true;window[AK]='';return true;}` +
    `if(c.length>1){window[AK]=c.length;return false;}return false;})()`;
  return [
    { phase, action: "wait_js", optional: true, js: clickJs, timeout: timeoutMs },
    {
      phase,
      action: "extract",
      as: seenVar,
      js: "JSON.stringify(window.__acScreen||{name:'unknown'})",
    },
    {
      phase,
      action: "assert",
      js: `!window.__acAmbig_${key}`,
      message: `Ambiguous '${label}' button (2+ matches) — fail-closed: galat button nahi dabayenge`,
    },
    {
      phase,
      action: "assert",
      js: `window.__acClicked_${key}===true`,
      message: `'${label}' button nahi mila (timeout) — screen vars.${seenVar} me dekho`,
    },
  ];
}

/**
 * Poora automation workflow — steps ka array (v3).
 * Har step me "phase" hai (phone ignore karta hai, server/logging ke liye).
 */
export function buildClipSteps(pkg: ClipPackage, campaignName?: string): Step[] {
  const captionQ = JSON.stringify(pkg.caption); // JS me safe embed
  const captionHeadQ = JSON.stringify(pkg.caption.slice(0, 24));
  const whopUrl = pkg.whop_submit_url;
  const campaignNameQ = campaignName ? JSON.stringify(campaignName) : null;

  const steps: Step[] = [
    // ---------- Phase 1: clip download ----------
    {
      phase: "download",
      action: "download",
      url: pkg.video_url,
      as: "reel.mp4",
    },

    // ---------- Phase 2: Instagram upload (Original = NO CROP) ----------
    // 2026-09-22 root-cause fix: /create/select/ pe SEEDHA navigate MAT karo —
    // IG ka server us URL ko @create naam ke user ki PROFILE samajh ke render
    // karta hai (shot_0.png proof). Sahi raasta: home feed kholo → bottom nav
    // ka + (New post) button JS se click karo → SPA khud /create/select/ pe
    // jaake asli "Create new post" dialog kholta hai.
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
    // Create button icon hai (text nahi) — aria-label se dhundho.
    // 2026-09-22 (attempt-3 lesson): wait aur click ko ALAG steps me mat todo —
    // wait pass hone aur click chalne ke beech me IG ka SPA DOM badal deta hai
    // (button transient dikha, click pe gayab → "button nahi mila").
    // Fix: EK HI wait_js jisme side-effect hai — har 700ms poll pe screen
    // identify + stash, phir: 1. dialog khula? (file input ya
    // "select from device/computer" text) → true; 2. nahi khula → + button
    // dhundhke click karo (10s me ek baar retry). Atomic find+click, koi race
    // nahi, dialog khulne tak khud verify.
    ...waitTarget(
      "ig-create-dialog",
      "__acW_create",
      90000,
      `(function(){var s=${IDENTIFY_EXPR};var now=Date.now();` +
        `if(document.querySelector('input[type="file"]')||/select from (computer|device)/i.test((document.body?document.body.innerText:''))){window.__acW_create=true;return true;}` +
        `window.__acW_create=false;` +
        `if(!window.__acPlusT||now-window.__acPlusT>10000){var btn=document.querySelector('[aria-label="New post"]')||[...document.querySelectorAll('a')].find(function(a){return (a.getAttribute('href')||'').indexOf('/create')===0;});if(btn){window.__acPlusT=now;btn.click();}}` +
        `return false;})()`,
      "Create-new-post dialog nahi khula (90s)",
      "screen_seen_create"
    ),
    // file chooser phone khud handle karta hai (reel.mp4)
    // 2026-09-22 p64: app ab TRUE desktop Instagram load karta hai
    // (client hints bhi desktop) → button "Select from computer".
    // text-regex dono variants cover karta hai taaki purana app/mobile UI
    // pe bhi step fail na ho (backward compatible).
    {
      phase: "ig-upload",
      action: "upload",
      by: "text-regex",
      value: "select from (computer|device)",
      file: "reel.mp4",
    },
    // crop screen — turant server pe screenshot (visual proof, job-end ka wait nahi)
    shot("ig-crop", "proof_crop_screen"),
    // 2026-09-22 lesson: mobile web pe "Original" text option ho bhi sakta hai,
    // nahi bhi. Exact-text click fail = poora job fail (8c63d727: "click fail: Original").
    // Fix: tolerant wait_js — "Original" label mile to click karo, na mile to
    // default pe continue (9:16 source pe IG default full-frame hi rakhta hai).
    // Cycle-button ko kabhi blind click mat karo (galat ratio select ho jayega).
    ...waitTarget(
      "ig-original",
      "__acW_orig",
      40000,
      `(function(){var s=${IDENTIFY_EXPR};var now=Date.now();` +
        `if(!window.__acOrigT)window.__acOrigT=now;` +
        `if(window.__acOrigC&&now-window.__acOrigC>2000){window.__acW_orig=true;return true;}` +
        `window.__acW_orig=false;` +
        `if(now-window.__acOrigT>25000){window.__acW_orig=true;return true;}` +
        `var els=document.querySelectorAll('button,[role="button"],[role="option"],li');` +
        `for(var i=0;i<els.length;i++){var el=els[i];if(!el.getClientRects||el.getClientRects().length===0)continue;` +
        `var t=(el.innerText||'').trim().toLowerCase();var al=(el.getAttribute('aria-label')||'').toLowerCase();` +
        `if(t==='original'||t.indexOf('original')===0||al.indexOf('original')===0){` +
        `if(!window.__acOrigC){window.__acOrigC=now;var b=(el.closest?el.closest('button,[role="button"]'):null)||el;b.click();}return false;}}` +
        `return false;})()`,
      "Crop/Original screen handle nahi hui (40s)",
      "screen_seen_crop"
    ),
    // Crop ke baad Next — fail-closed click (tolerant, ambiguous → fail)
    ...failClosedClick("ig-next1", "Next1", "Next", "^next$", 60000, "screen_seen_next1"),

    // ---------- Caption tak smart advance (blind Next loop KHATAM) ----------
    // 2026-09-22 lesson (jobs 7dd86beb/d0733fdc): crop ke baad blind Next se
    // caption screen kabhi nahi aayi — "wait_js timeout: Write a caption" pe
    // dono mare, aur koi evidence nahi mili (live_steps khaali).
    // v3: intermediate screens (trim/cover/filter/music) NAAM se detect, har
    // screen ka apna handler (exactly-1 advance button, 4s throttle).
    // UNKNOWN screen ya budget-exhaust → shot_upload + page-text excerpt ke
    // saath fail-closed. Kabhi blind Next nahi.
    {
      phase: "ig-advance",
      action: "wait_js",
      optional: true,
      timeout: 180000,
      js:
        `(function(){var s=${IDENTIFY_EXPR};` +
        // target: caption screen (3 me se koi 1 signal kaafi — teeno signals
        // har poll pe window.__acScreen.signals me logged hain)
        `if(s.name==='caption'){window.__acW_adv=true;window.__acUnknown='';window.__acStuck='';window.__acUnexpected='';return true;}` +
        `window.__acW_adv=false;` +
        // reel share ho gaya bina caption ke = unexpected (requirement tootegi)
        `if(s.name==='shared'||s.name==='sharing'){window.__acUnexpected='already-sharing';return false;}` +
        `window.__acUnexpected='';` +
        // naam se pehchani hui intermediate screens → apna handler
        `var H={trim:/^done$/i,cover:/^(done|next)$/i,filter:/^next$/i,music:/^(done|next)$/i,crop:/^next$/i};` +
        `var h=H[s.name];` +
        `if(h){window.__acUnknown='';var now=Date.now();` +
        `if(!window.__acAdvT||now-window.__acAdvT>4000){` +
        `var c=[];document.querySelectorAll('button,[role="button"],a').forEach(function(e){` +
        `var t=((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')).trim();` +
        `try{var r=e.getBoundingClientRect();if(r.width<4||r.height<4)return;}catch(x){return;}` +
        `if(h.test(t))c.push(e);});` +
        `if(c.length===1){window.__acAdvT=now;window.__acStuck='';c[0].scrollIntoView({block:'center'});c[0].click();}` +
        `else{window.__acStuck=s.name+':advance-'+(c.length===0?'missing':'ambiguous('+c.length+')');}}` +
        `return false;}` +
        // naam na pehchana → UNKNOWN — blind click KABHI nahi
        `window.__acUnknown=s.name;return false;})()`,
    },
    // Task-required: unknown/budget-exhaust pe shot_upload + page-text excerpt
    // ke saath fail-closed. (Shot hamesha jata hai — success pe milestone proof.)
    shot("ig-advance", "proof_advance_screen", "advance-loop end state"),
    {
      phase: "ig-advance",
      action: "extract",
      as: "screen_seen_advance",
      js: "JSON.stringify(window.__acScreen||{name:'unknown'})",
    },
    {
      phase: "ig-advance",
      action: "extract",
      as: "page_excerpt",
      js: "(document.body?document.body.innerText:'').slice(0,800)",
    },
    {
      phase: "ig-advance",
      action: "extract",
      as: "advance_stuck",
      js: "String(window.__acStuck||'')",
    },
    {
      phase: "ig-advance",
      action: "assert",
      js: "!window.__acUnknown",
      message:
        "Unknown intermediate screen — blind Next nahi karenge (shot proof_advance_screen + vars.screen_seen_advance + vars.page_excerpt dekho)",
    },
    {
      phase: "ig-advance",
      action: "assert",
      js: "!window.__acStuck",
      message:
        "Intermediate screen ka advance button missing/ambiguous — fail-closed (vars.advance_stuck + vars.screen_seen_advance dekho)",
    },
    {
      phase: "ig-advance",
      action: "assert",
      js: "window.__acW_adv===true",
      message:
        "Caption screen nahi mili (180s) — last screen vars.screen_seen_advance me, shot proof_advance_screen dekho",
    },
    // caption screen milestone proof
    shot("ig-caption", "proof_precaption"),
    // caption type (proven eval) + VERIFY — pehle verify hota hi nahi tha
    {
      phase: "ig-caption",
      action: "eval",
      js: `(function(){var el=document.querySelector('[aria-label^="Write a caption"]');if(!el)return 'no-box';el.focus();try{document.execCommand('selectAll',false,null)}catch(e){}var ok=false;try{ok=document.execCommand('insertText',false,${captionQ})}catch(e){}el.dispatchEvent(new Event('input',{bubbles:true}));return ok?'typed':'fail';})()`,
    },
    {
      phase: "ig-caption",
      action: "assert",
      js: `(function(){var q=${captionHeadQ};var el=document.querySelector('[aria-label^="Write a caption"],textarea[aria-label*="caption" i]');if(!el)return false;var v=el.value||el.innerText||'';return v.indexOf(q)!==-1;})()`,
      message: "Caption type verify nahi hua — textbox me caption text nahi dikha",
    },
    // Share — fail-closed click
    ...failClosedClick("ig-share", "Share", "Share", "^share$", 90000, "screen_seen_share"),
    // upload processing me time lagta hai — shared/reel-page screen ka wait
    ...waitTarget(
      "ig-shared",
      "__acW_shared",
      300000,
      `(function(){var s=${IDENTIFY_EXPR};` +
        `if(s.name==='shared'||s.name==='reel-page'){window.__acW_shared=true;return true;}` +
        `window.__acW_shared=false;return false;})()`,
      "Reel share confirm nahi hua (5 min)",
      "screen_seen_shared"
    ),
    // Canonical reel URL + id + upload timestamp
    {
      phase: "ig-reel-url",
      action: "extract",
      as: "reel_url",
      js: "(function(){var m=location.href.match(/https?:\\/\\/(www\\.)?instagram\\.com\\/reel\\/[^\\/\\?\\#]+/);return m?m[0]:location.href;})()",
    },
    {
      phase: "ig-reel-url",
      action: "extract",
      as: "reel_id",
      js: "(function(){var m=location.href.match(/\\/reel\\/([^\\/\\?\\#]+)/);return m?m[1]:'';})()",
    },
    { phase: "ig-time", action: "extract", as: "t_upload_ms", js: "Date.now().toString()" },
    shot("ig-reel-url", "proof_reel_posted"),

    // ---------- Phase 3: DOUBLE-CHECK live reel — Whop submit se PEHLE ----------
    // Canonical URL dobara kholo → video element assert → 2 frames
    // (shot_upload) → URL me reel-id match. Tabhi submit.
    { phase: "verify-open", action: "navigate", url: "{{reel_url}}" },
    ...waitTarget(
      "verify-video",
      "__acW_video",
      60000,
      `(function(){var s=${IDENTIFY_EXPR};` +
        `if(document.querySelector('video')){window.__acW_video=true;return true;}` +
        `window.__acW_video=false;return false;})()`,
      "Live reel page pe video element nahi mila (60s) — upload fail ho sakta hai",
      "screen_seen_verify"
    ),
    shot("verify-video", "proof_reel_live_1"),
    // doosra frame thode gap pe (2 alag frames ka proof)
    {
      phase: "verify-delay",
      action: "wait_js",
      js: "(function(){var t0=window.__acDelay0||(window.__acDelay0=Date.now());return Date.now()-t0>2500;})()",
      timeout: 10000,
    },
    shot("verify-video", "proof_reel_live_2"),
    {
      phase: "verify-video",
      action: "assert",
      js: "!!document.querySelector('video')",
      message: "Live reel page pe video nahi mila — upload fail ho sakta hai",
    },
    {
      phase: "verify-reelid",
      action: "assert",
      js: "(function(){var id='{{reel_id}}';return !!id&&location.href.indexOf(id)!==-1;})()",
      message: "Reel page URL me reel-id match nahi hua — galat page khul gaya?",
    },
    {
      phase: "verify-title",
      action: "extract",
      as: "page_title",
      js: "document.title||''",
    },

    // ---------- Phase 4: Whop submit (30 min ke andar, EXACT campaign URL pe) ----------
    { phase: "whop-open", action: "navigate", url: whopUrl },
    // Fail-closed campaign identity: page ka campaign naam nikalo, payload ke
    // expected campaign_name se match karo — mismatch → submit se PEHLE fail.
    // (campaign_name na ho — purane/schedule-tick manual clips — to check skip.)
    ...(campaignName
      ? [
          {
            phase: "whop-identity",
            action: "extract",
            as: "whop_page_name",
            js: "(function(){var h=document.querySelector('h1');var t=h?(h.innerText||''):document.title;return (t||'').trim().slice(0,120);})()",
          },
          {
            phase: "whop-identity",
            action: "assert",
            js:
              `(function(){var exp=${campaignNameQ};` +
              `function n(s){return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}` +
              `var a=n(exp);var h=document.querySelector('h1');var got=h?(h.innerText||''):document.title;var b=n(got);` +
              `return !!(a&&b&&(b.indexOf(a)!==-1||a.indexOf(b)!==-1));})()`,
            message:
              `Whop campaign name mismatch — expected '${campaignName.slice(0, 60)}' — galat campaign pe submit nahi karenge (page naam vars.whop_page_name me)`,
          },
        ]
      : []),
    // submit UI ka wait (tolerant — button text variants)
    ...waitTarget(
      "whop-submit-ui",
      "__acW_whopsubmit",
      90000,
      `(function(){var s=${IDENTIFY_EXPR};` +
        `var vis=function(e){try{var r=e.getBoundingClientRect();return r.width>4&&r.height>4;}catch(x){return false;}};` +
        `var n=0;document.querySelectorAll('button,[role="button"],a,input[type="submit"]').forEach(function(e){` +
        `var t=((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.value||'')).trim();` +
        `if(/^(submit|submit clip)$/i.test(t)&&vis(e))n++;});` +
        `if(n>0){window.__acW_whopsubmit=true;return true;}window.__acW_whopsubmit=false;return false;})()`,
      "Whop submit UI nahi mili (90s) — Submit button nahi dikha",
      "screen_seen_whop"
    ),
    // v1 me PROVEN selector: URL field me reel link paste + VERIFY (pehle
    // verify hota hi nahi tha — paste fail silent rehta tha)
    {
      phase: "whop-paste",
      action: "eval",
      js: "(function(){var fs=[...document.querySelectorAll('input[type=\"url\"],input[placeholder*=\"nstagram\"],input[placeholder*=\"ink\"]')];var f=fs[0];if(!f)return 'no-field';f.focus();try{document.execCommand('selectAll',false,null)}catch(e){}document.execCommand('insertText',false,'{{reel_url}}');f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('change',{bubbles:true}));return 'pasted';})()",
    },
    {
      phase: "whop-paste",
      action: "assert",
      js: "(function(){var id='{{reel_id}}';if(!id)return false;var els=document.querySelectorAll('input');for(var i=0;i<els.length;i++){if((els[i].value||'').indexOf(id)!==-1)return true;}return false;})()",
      message: "Reel URL paste verify nahi hua — field me reel URL nahi dikha",
    },
    // Submit — fail-closed click
    ...failClosedClick("whop-submit", "Submit", "Submit", "^(submit|submit clip)$", 90000, "screen_seen_whopsubmit"),
    // "Clip submitted" confirm
    ...waitTarget(
      "whop-confirm",
      "__acW_whopconfirm",
      90000,
      `(function(){var s=${IDENTIFY_EXPR};var b=(document.body?document.body.innerText:'')||'';` +
        `if(/clip submitted/i.test(b)){window.__acW_whopconfirm=true;return true;}` +
        `window.__acW_whopconfirm=false;return false;})()`,
      "Whop pe 'Clip submitted' confirmation nahi mila (90s)",
      "screen_seen_whopconfirm"
    ),
    {
      phase: "whop-assert",
      action: "assert",
      js: "/clip submitted/i.test(document.body?document.body.innerText:'')",
      message: "Whop pe 'Clip submitted' confirmation nahi mila",
    },
    shot("whop-submit", "proof_whop_submitted"),
    { phase: "whop-time", action: "extract", as: "t_submit_ms", js: "Date.now().toString()" },

    // ---------- Phase 5: Whop submissions me jaake verify (best-effort) ----------
    { phase: "sub-open", action: "navigate", url: "https://whop.com/content-rewards/", optional: true },
    { phase: "sub-wait", action: "wait_text", text: "Pending", timeout: 60000, optional: true },
    { ...shot("sub-shot", "proof_whop_dashboard"), optional: true },

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
  campaignUrl: string,
  whopUrl?: string
): Record<string, unknown> {
  return {
    workflow: "v2-join-campaign",
    workflow_version: 2,  // v2: pehle whop join, phir campaign join (2026-09-20 verified)
    campaign_slug: campaignSlug,
    campaign_url: campaignUrl,
    // Brand ka Whop (community) — pehle iska member banna padta hai
    // (FundingPips: free tha, koi payment nahi). Phir campaign join hota hai.
    whop_url: whopUrl || "",
    join_steps: [
      "1. whop_url kholo (brand ka Whop page)",
      "2. Agar 'Join' button dikhe to dabao (free hona chahiye; agar payment mange to STOP + needs_user)",
      "3. campaign_url kholo (contentrewards.com preview)",
      "4. 'Join Campaign' dabao → Whop app me deep link hoga",
      "5. Verify: Whop app me campaign kholo — 'Accepting clips' + 'Submit clip' button = joined",
    ],
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

/**
 * discover_campaigns job payload (Round-7b, 2026-09-19).
 *
 * Server ke paas Whop login NAHI hai — naye campaigns bhi PHONE dhoondta hai.
 * Phone apne logged-in Whop session me discover_url kholta hai (default:
 * https://whop.com/hub/ — Content Rewards section), campaign cards nikalta hai
 * (name, campaign_url, payout text) aur result bhejta hai. Result route unhe
 * campaigns table me upsert karta hai (active=true) — phir verify protocol
 * unpe chalta hai.
 *
 * Phone ka dedicated handler: JobEngine.runDiscoverCampaigns (p24+).
 * Result vars: discover_status = discovered | needs_user | failed,
 *   discover_results (JSON array), discover_detail.
 */
export function buildDiscoverCampaignsPayload(
  discoverUrl: string
): Record<string, unknown> {
  return {
    workflow: "v2-discover-campaigns",
    workflow_version: 1,
    discover_url: discoverUrl,
  };
}

/** Whop Content Rewards discovery — logged-in hub (campaign cards yahin). */
export const WHOP_DISCOVER_URL = "https://whop.com/discover/content-rewards/";

/**
 * Job payload: phone JobEngine seedha chala leta hai.
 * v3 (2026-09-22): workflow_version 3 — shot_upload + identify-then-act +
 * fail-closed campaign identity (campaign_name). opts.campaign_name na ho to
 * identity check skip hota hai (purane/schedule-tick manual clips).
 */
export function buildAutomationPayload(
  pkg: ClipPackage,
  opts?: { campaign_slug?: string; campaign_name?: string }
): Record<string, unknown> {
  return {
    workflow: "v2-clip-post",
    workflow_version: 3,
    video_url: pkg.video_url,
    caption: pkg.caption,
    whop_submit_url: pkg.whop_submit_url,
    // campaign dedup ke liye (v2_submissions.unique(user_id, campaign_slug))
    campaign_slug: opts?.campaign_slug ?? null,
    // fail-closed campaign identity (whop-identity step)
    campaign_name: opts?.campaign_name ?? null,
    steps: buildClipSteps(pkg, opts?.campaign_name),
  };
}

// v3 rebuild live — 2026-09-22 ground-zero reset (observability first-class)
