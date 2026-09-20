#!/usr/bin/env python3
"""agent_quiz.py — MCQ mastery quiz (knowledge-file scenario checks).

Har skill ke `lib/agent/knowledge/<skill>.md` pe multiple-choice scenario
questions chalti hain. Har question me ek correct choice + 2-3 plausible
wrong choices hain — focus HARD RULES aur failure-library ke traps pe hai
(MoonPay required footage, FundingPips bio hold, no substitute footage,
9:16 safe zones, locked Content Rewards as unlock route, payment→needs_user,
force_update fail-closed, deterministic-vs-transient order, ...).

Grading deterministic + rule-based hai (koi network, koi randomness nahi):
har choice ke evidence-phrases knowledge file text me gine jate hain
(case-insensitive substring); jis choice ka evidence sabse zyada match kare
wo "file ka jawab" mana jata hai. Sahi jawab jeetta hai + `required` phrases
sab maujood hon to scenario PASS. Ye quiz regression guard bhi hai: koi
knowledge file edit karke hard rule hata/blur kar de to agli trainer run me
sawal fail honge aur skill gate ho jayegi — silent knowledge loss impossible.

Score (0..1) trainer me mastery_score me judta hai: quiz scenario outcomes
eval_history me entries banke jaate hain (source:"knowledge_quiz",
scenario_id, knowledge_version, rule_id) — existing mastery formula
(0.5*last10 + 0.3*last30 + 0.2*0.5) unhe normal job outcomes ki tarah
gin-ta hai. Koi alag blend nahi. Dedup: (scenario_id, knowledge_version).

Interface (agent_trainer.py se zero-edit compatible):
    run_quiz()            -> {skill: result}            (trainer yehi call karta hai)
    run_quiz("skill-key") -> single skill ka result dict {score, total, details, ...}
    run_quiz(["a","b"])   -> subset ka {skill: result}
Result: {score, passed, total, failures, scenarios, details, version}
  scenarios: [{scenario_id, rule_id, passed}]  <- trainer eval entries banata hai
  details:   [{question_id, rule_id, question, choices, correct, picked, passed}]
"""

from __future__ import annotations

import os

KNOWLEDGE_VERSION = "1.0.0"
QUIZ_GATE = 0.6

WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
KNOWLEDGE_DIR = os.path.normpath(
    os.path.join(WORKER_DIR, "..", "lib", "agent", "knowledge"))

# skill -> (knowledge file, minimum hard-rule count)
SKILLS = {
    "campaign-scout": ("campaign-scout.md", 9),
    "compliance-guard": ("compliance-guard.md", 8),
    "render-director": ("render-director.md", 10),
    "upload-coordinator": ("upload-coordinator.md", 7),
    "submit-verifier": ("submit-verifier.md", 8),
    "recovery-specialist": ("recovery-specialist.md", 7),
}

# ---------------------------------------------------------------------------
# QUESTIONS — skill -> list of dicts:
#   id, rule (hard-rule id), q (scenario), choices, correct (index),
#   ev: {choice_idx: [evidence phrases]}, required: [must-be-present phrases]
# ---------------------------------------------------------------------------

QUESTIONS: dict[str, list[dict]] = {
    "campaign-scout": [
        {
            "id": "cs-locked-rewards",
            "rule": "campaign-scout.R5",
            "q": ("Whop pe brand community page khula hai. 'Content Rewards' section "
                  "pe LOCK icon hai — kahin 'Join' text nahi dikh raha. Goal: rewards "
                  "access. Sahi action kya hai?"),
            "choices": [
                "Lock icon wale element ko tap karo — ye tap-to-unlock darwaza hai; "
                "modal khule to dobara perceive karke andar ka rasta decide karo.",
                "'Join' text dhoondhte raho; na mile to 15s wait karke dobara dhoondho.",
                "Locked section ko 'login required' samajh ke needs_user declare "
                "karke ruk jao.",
            ],
            "correct": 0,
            "ev": {
                0: ["tap-to-unlock", "lock", "modal"],
                1: ["join text dhoondhte raho", "15s wait karke dobara"],
                2: ["login required", "ruk jao"],
            },
            "required": ["tap-to-unlock", "content rewards"],
        },
        {
            "id": "cs-no-repeat",
            "rule": "campaign-scout.R1",
            "q": ("Scoring me MoonPay campaign sabse upar aayi (payout high), lekin "
                  "submissions me uski entry hai (reel DdQvohrhVDU, Pending). Kya karo?"),
            "choices": [
                "MoonPay permanent skip karo — submitted = kabhi dobara nahi; "
                "next-best eligible campaign pick karo.",
                "Score sabse high hai to MoonPay hi pick karo — payout pehle.",
                "MoonPay ko pool me rakho lekin deprioritize karo; option khula rakho.",
            ],
            "correct": 0,
            "ev": {
                0: ["no-repeat", "submitted", "permanent"],
                1: ["payout pehle", "score sabse high"],
                2: ["deprioritize", "option khula"],
            },
            "required": ["no-repeat", "submitted"],
        },
        {
            "id": "cs-brief-missing",
            "rule": "campaign-scout.R8",
            "q": ("Ek high-score campaign ka brief_url khaali hai. Join ho sakta hai, "
                  "lekin clip ke liye verified video link nahi hai. Sahi declare?"),
            "choices": [
                "`skipped:no_brief` declare karo (join_only) — clip/download stage "
                "CANNOT run; force render mana hai.",
                "'Brief merge complete' milestone pe bharosa karke clip stage chalao.",
                "YouTube se koi similar video utha ke render kar do — kuch to banao.",
            ],
            "correct": 0,
            "ev": {
                0: ["skipped:no_brief", "brief_url", "cannot run"],
                1: ["milestone pe bharosa", "merge complete"],
                2: ["similar video utha", "kuch to banao"],
            },
            "required": ["brief_url", "no_brief"],
        },
        {
            "id": "cs-inactive",
            "rule": "campaign-scout.R3",
            "q": ("Discover me `perplexity-jre-clipfarm` dikhi — purani high payout "
                  "wali campaign. User ne ise inactive kiya tha (upload ho chuka)."),
            "choices": [
                "Pick/reactivate mat karo — user ke inactive decision ko override "
                "karna mana hai.",
                "Payout high hai to pick karo — active pool me wapas lao.",
                "Test ke liye ek baar reactivate karo, phir user se poocho.",
            ],
            "correct": 0,
            "ev": {
                0: ["inactive", "reactivate mat karo", "perplexity"],
                1: ["wapas lao", "payout high hai to pick"],
                2: ["test ke liye", "ek baar reactivate"],
            },
            "required": ["inactive", "perplexity-jre-clipfarm"],
        },
        {
            "id": "cs-community-first",
            "rule": "campaign-scout.R6",
            "q": ("Campaign join karna hai. Server ne `whop_url` (brand community link) "
                  "bheja hai. Join flow ka sahi order?"),
            "choices": [
                "Pehle brand community join (free check; payment mange to needs_user), "
                "phir campaign join. `whop_url` ke bina flow shuru mat karo.",
                "Seedha campaign join karo — community join baad me dekh lenge.",
                "`whop_url` optional hai; bina iske bhi join flow chal sakta hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["whop_url", "community join", "pehle"],
                1: ["seedha campaign join", "baad me dekh"],
                2: ["optional hai", "bina iske bhi"],
            },
            "required": ["whop_url", "community"],
        },
    ],
    "compliance-guard": [
        {
            "id": "cg-payment-veto",
            "rule": "compliance-guard.R1",
            "q": ("Campaign requirements: 'Join Pro — $5/mo subscription required for "
                  "rewards eligibility'. Brain clip_post enqueue karna chahta hai."),
            "choices": [
                "HARD VETO — HIGH agent_issue + needs_user; enqueue KABHI nahi. "
                "Auto-pay/auto-subscribe kisi bhi surat me nahi.",
                "User ne all-time approval diya hai, to $5/mo accept kar lo.",
                "Sirf $1 ka trial hai to chhota amount hai — accept karke aage badho.",
            ],
            "correct": 0,
            "ev": {
                0: ["auto-pay", "veto", "needs_user", "kabhi nahi"],
                1: ["all-time approval", "accept kar lo"],
                2: ["chhota amount", "trial hai to"],
            },
            "required": ["auto-pay", "needs_user"],
        },
        {
            "id": "cg-locked-not-login",
            "rule": "compliance-guard.R2",
            "q": ("'Content Rewards' LOCKED dikh raha hai. Kuch agents ise 'login "
                  "required' samajh rahe hain. Sahi faisla?"),
            "choices": [
                "Veto nahi — locked Content Rewards unlock ek VALID route hai, "
                "login-required nahi; unlock flow chalao.",
                "'Login required' samajh ke veto karo aur needs_user declare karo.",
                "Confusion hai to campaign skip karke doosri lo.",
            ],
            "correct": 0,
            "ev": {
                0: ["valid route", "unlock", "nahi hai"],
                1: ["veto karo", "declare karo"],
                2: ["skip karke", "doosri lo"],
            },
            "required": ["locked", "valid route"],
        },
        {
            "id": "cg-placeholder-caption",
            "rule": "compliance-guard.R3",
            "q": ("Campaign ka caption_template: '[Insert your caption here] #brand'. "
                  "brief_url valid hai. Enqueue se pehle kya?"),
            "choices": [
                "VETO → needs_review. Placeholder/exact-caption-nahi = reject risk; "
                "pehle caption normalize ho, phir dobara evaluate.",
                "brief_url valid hai to post kar do — caption baad me theek ho jayega.",
                "Placeholder ko as-is post karo, campaign wale samajh jayenge.",
            ],
            "correct": 0,
            "ev": {
                0: ["placeholder", "veto", "20"],
                1: ["baad me theek", "post kar do"],
                2: ["as-is post", "samajh jayenge"],
            },
            "required": ["placeholder", "caption"],
        },
        {
            "id": "cg-ugc-veto",
            "rule": "compliance-guard.R5",
            "q": ("Requirements: 'face-cam pe khud record karo — original video chahiye'. "
                  "Automation se clip banana hai."),
            "choices": [
                "VETO — original UGC/face-cam requirement automation se compliant "
                "nahi banega; aisa campaign automation me nahi jayega.",
                "Stock footage se face-cam jaisa look bana lo.",
                "AI avatar se talking-head generate karke requirement poori karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["UGC", "face-cam", "veto"],
                1: ["stock footage", "jaisa look"],
                2: ["ai avatar", "talking-head generate"],
            },
            "required": ["UGC", "face-cam"],
        },
        {
            "id": "cg-fundingpips-hold",
            "rule": "compliance-guard.R6",
            "q": ("Campaign c0c37381 (FundingPips). notes.required_bio_link = "
                  "'https://go.fundingpips.com/Zero_Bio' set hai, lekin bio_link_set "
                  "true nahi hai. Kya karo?"),
            "choices": [
                "HOLD — bio link set + requirements normalized hue bina join/post "
                "nahi (safety hold).",
                "Bio baad me laga denge — pehle post karke momentum banao.",
                "Koi doosra bio link laga do, kaam chal jayega.",
            ],
            "correct": 0,
            "ev": {
                0: ["bio", "hold", "fundingpips"],
                1: ["baad me laga", "momentum banao"],
                2: ["doosra bio link", "kaam chal"],
            },
            "required": ["bio_link", "fundingpips"],
        },
    ],
    "render-director": [
        {
            "id": "rd-safe-zones",
            "rule": "render-director.R2",
            "q": ("Rendered clip ka hook top se 7% pe hai, captions 87% height pe. "
                  "IG pe kya hoga aur fix kya hai?"),
            "choices": [
                "Hook ≥10% below top (200px/1920) aur captions at/above ~78% rakho — "
                "IG top/bottom/right UI text kha jata hai; re-render karo.",
                "7% theek hai — IG app khud adjust kar lega, re-render ki zaroorat nahi.",
                "Captions neeche hi achhe lagte hain; hook thoda upar rakhna style hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["10%", "78%", "re-render"],
                1: ["7% theek", "adjust kar lega"],
                2: ["neeche hi achhe", "style hai"],
            },
            "required": ["10%", "78%"],
        },
        {
            "id": "rd-moonpay-footage",
            "rule": "render-director.R8",
            "q": ("MoonPay brief ka REQUIRED moment 'The Moment MoonPay Got Its Name' "
                  "(fZtY0OeR8h8, 05:53–06:52) kisi YouTube client pe available nahi; "
                  "@Ivansotowright/videos 404 hai. Kya karo?"),
            "choices": [
                "Posting se pehle run SELF-STOP karo. Substitute footage (Solana "
                "interview jaisa 'similar' source) KABHI nahi — reject + account risk.",
                "Solana Accelerate interview (kI2w01qOLy4) ka footage use kar lo — "
                "Ivan hi bol raha hai.",
                "Required moment skip karke baaki brief follow karo — kuch to post karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["self-stop", "substitute", "kabhi nahi"],
                1: ["solana", "kI2w01qOLy4"],
                2: ["skip karke", "kuch to post"],
            },
            "required": ["substitute", "self-stop"],
        },
        {
            "id": "rd-ytdlp-long",
            "rule": "render-director.R10",
            "q": ("2.5h ke JRE podcast se 60s ka section download karna hai. "
                  "Datacenter IP pe YouTube 429/bot-block ka risk hai. Sahi tareeka?"),
            "choices": [
                "`yt-dlp -g` se direct URL nikalo, phir `ffmpeg -ss/-t` se HTTP range "
                "seek; multi-round ytgrab (android→ios→web, 4 rounds). "
                "`--download-sections` long video pe MANA.",
                "`yt-dlp --download-sections` se seedha section download karo.",
                "Poori 2.5h video download karke local me kaato — simple hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["yt-dlp -g", "ffmpeg -ss", "download-sections"],
                1: ["--download-sections", "seedha section"],
                2: ["poori", "download karke"],
            },
            "required": ["yt-dlp", "download-sections"],
        },
        {
            "id": "rd-vp9-probe",
            "rule": "render-director.R6",
            "q": ("H.264 master theek hai; VP9 file upload ke liye ready dikh rahi hai. "
                  "Upload se pehle kya?"),
            "choices": [
                "Pehle ffprobe karo — VP9 disk pe corrupt ho sakti hai (no moov atom "
                "incident); invalid ho to master se re-encode karo.",
                "Master fine hai to VP9 bhi fine hogi — seedha upload karo.",
                "File size dekh ke andaza lagao — badi file matlab theek file.",
            ],
            "correct": 0,
            "ev": {
                0: ["ffprobe", "moov", "re-encode"],
                1: ["seedha upload", "fine hogi"],
                2: ["andaza lagao", "badi file"],
            },
            "required": ["ffprobe", "moov"],
        },
        {
            "id": "rd-live-brief-wins",
            "rule": "render-director.R7",
            "q": ("campaign_profile.json ka caption template purana hai (bina #MoonPay); "
                  "live MoonPay brief me @moonpay + #MoonPay required hai. Kisko mano?"),
            "choices": [
                "Live brief jeetta hai — hamesha. Stale profile pe bharosa nahi.",
                "Profile JSON repo me versioned hai, to wahi source of truth hai.",
                "Dono me se jo chhota caption ho, wahi use karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["live brief", "jeetta", "stale"],
                1: ["versioned hai", "source of truth"],
                2: ["chhota caption", "wahi use"],
            },
            "required": ["live brief", "stale"],
        },
    ],
    "upload-coordinator": [
        {
            "id": "uc-create-button",
            "rule": "upload-coordinator.R2",
            "q": ("IG mobile web pe upload flow me 'Create' dabana hai, lekin page pe "
                  "koi visible 'Create' text nahi (icon-only button). Sahi selector?"),
            "choices": [
                "`wait_js` se `[aria-label=\"New post\"]` / `/create` links / "
                "`/create/select/` dhoondho, phir JS click. `wait_text \"Create\"` "
                "GUARANTEED timeout dega.",
                "`wait_text \"Create\"` lagao — text kahin to hoga.",
                "Screen coordinates pe tap karo jahan Create icon lag raha hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["aria-label", "new post", "wait_text"],
                1: ["wait_text", "kahin to hoga"],
                2: ["coordinates", "tap karo"],
            },
            "required": ["aria-label", "new post"],
        },
        {
            "id": "uc-original-916",
            "rule": "upload-coordinator.R1",
            "q": ("Source file perfect 9:16 hai. Upload dialog me aspect/crop menu khula. "
                  "Kya karo?"),
            "choices": [
                "'Original' select karo aur confirm karo ki HIGHLIGHTED hai — har "
                "upload independent verification mangta hai (afternoon crop incident).",
                "File perfect hai to menu skip karke aage badho.",
                "Ek baar verify ho gaya to dobara zaroorat nahi — default theek hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["original", "highlighted", "independent"],
                1: ["menu skip", "aage badho"],
                2: ["dobara zaroorat nahi", "default theek"],
            },
            "required": ["original", "highlighted"],
        },
        {
            "id": "uc-action-block",
            "rule": "upload-coordinator.R5",
            "q": ("Upload ke dauraan 'Try again later' dikha. Sahi response?"),
            "choices": [
                "STOP — 24h auto-pause lagao, user ko notify karo. Aggressive retry "
                "MANA hai (block extend hota hai).",
                "Turant 3 baar retry karo — shayad temporary glitch hai.",
                "Doosre IG account se post kar do — ye wala rest karega.",
            ],
            "correct": 0,
            "ev": {
                0: ["action-block", "24h", "auto-pause"],
                1: ["retry karo", "temporary glitch"],
                2: ["doosre", "account se"],
            },
            "required": ["action-block", "24h"],
        },
        {
            "id": "uc-cam-mic",
            "rule": "upload-coordinator.R3",
            "q": ("Upload flow me camera permission prompt aa gaya. Kya karo?"),
            "choices": [
                "STOP + escalate (HIGH issue). Upload me camera/mic prompt kabhi nahi "
                "aana chahiye — prompt aana = galat flow.",
                "'Allow' karke aage badho — prompt to normal hai.",
                "Prompt ko ignore karke upload continue karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["camera", "stop", "escalate"],
                1: ["allow", "normal hai"],
                2: ["ignore karke", "continue karo"],
            },
            "required": ["camera", "stop"],
        },
        {
            "id": "uc-cap",
            "rule": "upload-coordinator.R5",
            "q": ("Pichhle 24 ghante me 4 automation runs ho chuke hain. Ek aur run "
                  "ki demand aayi. Kya karo?"),
            "choices": [
                "Cap full hai — `wait` karo, slot khulne pe retry. Cap kabhi bypass nahi.",
                "5th run chhota hai to chala lo — user ko pata nahi chalega.",
                "Cap sirf posts pe hai — join-type run abhi chala sakte ho.",
            ],
            "correct": 0,
            "ev": {
                0: ["cap", "bypass nahi", "4"],
                1: ["chala lo", "pata nahi chalega"],
                2: ["sirf posts", "join-type"],
            },
            "required": ["4", "cap"],
        },
    ],
    "submit-verifier": [
        {
            "id": "sv-frame-verify",
            "rule": "submit-verifier.R1",
            "q": ("Reel upload ho gayi ('success' dikha). Whop pe submit karne se pehle?"),
            "choices": [
                "Live Reel URL kholo aur ~1s (hook/title poora), ~7s, ~15s, ~25s "
                "(captions frame ke andar, edge se kate nahi) check karo — "
                "submit se PEHLE, har baar. Glance verification nahi chalegi.",
                "Upload success = sab theek — turant submit kar do.",
                "Ek glance me dekh lo, theek laga to submit; detail me time waste hai.",
            ],
            "correct": 0,
            "ev": {
                0: ["~1s", "~25s", "frame", "submit se pehle"],
                1: ["turant submit", "sab theek"],
                2: ["glance me", "time waste"],
            },
            "required": ["~1s", "~25s"],
        },
        {
            "id": "sv-cropped",
            "rule": "submit-verifier.R2",
            "q": ("~15s frame pe burned-in captions right edge se cut ho rahe hain "
                  "(like/comment buttons ke neeche). Deadline nazdeek hai."),
            "choices": [
                "Submit MAT karo — cropped Reel submit mana hai, chahe deadline ho. "
                "Captions upar karke re-render + re-upload, phir dobara verify.",
                "Deadline hai to submit kar do — thoda kata hai, chalega.",
                "Campaign ko note likh ke ('thoda crop hai') submit kar do.",
            ],
            "correct": 0,
            "ev": {
                0: ["cropped", "submit", "mana hai", "re-render"],
                1: ["deadline hai", "chalega"],
                2: ["note likh", "submit kar do"],
            },
            "required": ["cropped", "mana hai"],
        },
        {
            "id": "sv-protected",
            "rule": "submit-verifier.R6",
            "q": ("Blizzard Reel purani lag rahi hai; nayi Reel aa gayi hai. MoonPay "
                  "Reel DdQvohrhVDU bhi list me hai. Delete kar doon?"),
            "choices": [
                "Nahi. Blizzard Reel 2026-10-14 tak live rakho (delete = forfeit); "
                "MoonPay DdQvohrhVDU Whop confirm kare tabhi delete, warna nahi.",
                "Purani ho gayi hain — dono delete kar do, jagah banao.",
                "Nayi Reel aa gayi to purani ka kaam khatm — Blizzard wali hatao.",
            ],
            "correct": 0,
            "ev": {
                0: ["2026-10-14", "ddqvohrhvdu", "forfeit"],
                1: ["delete kar do", "jagah banao"],
                2: ["kaam khatm", "hatao"],
            },
            "required": ["2026-10-14", "ddqvohrhvdu"],
        },
        {
            "id": "sv-30min",
            "rule": "submit-verifier.R3",
            "q": ("Reel 14:02 IST pe live hui; verification 14:09 pe pass; ab 14:50 hai, "
                  "submit abhi tak nahi hua. Kya karo?"),
            "choices": [
                "Turant submit karo — post→submit 30 min hard limit hai. Window miss "
                "hote hue bhi submit mat chhodo; miss ko tracking me note karo.",
                "30 min nikal gaye — ab submit ka fayda nahi, kal nayi post karenge.",
                "Dobara post karke phir submit karo — timer reset ho jayega.",
            ],
            "correct": 0,
            "ev": {
                0: ["30 min", "turant submit", "note karo"],
                1: ["fayda nahi", "kal nayi"],
                2: ["dobara post", "timer reset"],
            },
            "required": ["30 min"],
        },
        {
            "id": "sv-proof",
            "rule": "submit-verifier.R5",
            "q": ("Upload + submit dono ho gaye, sab theek dikha — lekin koi screenshot "
                  "proof nahi liya. Status kya declare karo?"),
            "choices": [
                "'Succeeded' claim nahi — bina screenshot proof (upload, live frames, "
                "submit confirmation) ke claim mana hai. Proof jodo, phir declare karo.",
                "Sab theek dikha to proof ki zaroorat nahi — succeeded declare karo.",
                "User ne live dekha hoga — proof baad me jod denge.",
            ],
            "correct": 0,
            "ev": {
                0: ["screenshot", "proof", "claim nahi"],
                1: ["zaroorat nahi", "declare karo"],
                2: ["baad me jod"],
            },
            "required": ["screenshot", "proof"],
        },
    ],
    "recovery-specialist": [
        {
            "id": "rs-deterministic-first",
            "rule": "recovery-specialist.R2",
            "q": ("Planner exclusion query pe `42703` aaya (submissions me campaign_id "
                  "column nahi). Stdout tail me purani 'remotedisconnected' lines bhi "
                  "hain. Watchdog kya kare?"),
            "choices": [
                "DETERMINISTIC — seedha failed, requeue nahi. Deterministic check "
                "(`42703`/`does not exist`/`pgrst`) transient-retry match se PEHLE "
                "aana chahiye, warna infinite requeue loop banta hai.",
                "'remotedisconnected' dikha to transient samajh ke requeue karo.",
                "3 baar retry karke dekho — shayad DB theek ho jaye.",
            ],
            "correct": 0,
            "ev": {
                0: ["42703", "deterministic", "pehle"],
                1: ["transient samajh", "requeue karo"],
                2: ["retry karke", "theek ho jaye"],
            },
            "required": ["42703", "deterministic"],
        },
        {
            "id": "rs-stale-cutoff",
            "rule": "recovery-specialist.R1",
            "q": ("Job ka last heartbeat 12 min purana hai, `heartbeat_count=3`. "
                  "Stuck hai ya nahi — kis evidence se decide karo?"),
            "choices": [
                "Stuck — heartbeat-capable job (`heartbeat_count > 0`) pe 10 min "
                "cutoff lagta hai. `x-app-version` header se stale decide mat karo.",
                "Nahi stuck — heartbeat_count>0 matlab job alive hai.",
                "x-app-version header purana hai isliye stuck declare karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["heartbeat_count", "10 min", "cutoff"],
                1: ["alive hai", "nahi stuck"],
                2: ["x-app-version", "header"],
            },
            "required": ["heartbeat_count", "10 min"],
        },
        {
            "id": "rs-join-reconcile",
            "rule": "recovery-specialist.R3",
            "q": ("Join POST network blip me timeout hua — response kho gaya. Planner "
                  "`skipped:join_failed` dene wala hai. Sahi step?"),
            "choices": [
                "Pehle `live_join_job` se reconcile karo — job mil gaya to "
                "`skipped:join_pending`; har non-ok response ka body log karo. "
                "Response kho jana ≠ kaam nahi hua.",
                "Response nahi mila = kaam nahi hua — seedha failed kaho.",
                "Turant dobara join POST karo — duplicate bane to dekha jayega.",
            ],
            "correct": 0,
            "ev": {
                0: ["live_join_job", "join_pending", "reconcile"],
                1: ["kaam nahi hua", "failed kaho"],
                2: ["dobara join", "duplicate bane"],
            },
            "required": ["live_join_job", "join_pending"],
        },
        {
            "id": "rs-unknown-column",
            "rule": "recovery-specialist.R7",
            "q": ("PostgREST PATCH 400 de raha hai: 'column \"note\" does not exist' "
                  "(PGRST204). Watchdog months se isi pe fail ho raha tha. Fix?"),
            "choices": [
                "Column existence LIVE DB pe verify karo "
                "(`/rest/v1/<table>?select=<col>&limit=1`) — migration file pe bharosa "
                "nahi; ek unknown column poora PATCH fail karta hai, code fix karo.",
                "Retry karte raho — shayad transient network issue hai.",
                "Poora table drop karke migration dobara chalao.",
            ],
            "correct": 0,
            "ev": {
                0: ["live db", "verify karo", "400"],
                1: ["retry karte", "transient"],
                2: ["table drop", "dobara chalao"],
            },
            "required": ["does not exist", "400"],
        },
        {
            "id": "rs-empty-read",
            "rule": "recovery-specialist.R4",
            "q": ("Bridge GET `?box=approvals` ek baar `[]` (khaali) aaya, jabki queue "
                  "me items the. Iska matlab?"),
            "choices": [
                "Unverified — 2–3s baad retry karo. Single empty read ko 'kuch pending "
                "nahi' kabhi mat mano (transient khaali read hota hai).",
                "Queue khaali hai — aage badho, kuch pending nahi.",
                "Empty matlab sab approved ho gaye — success declare karo.",
            ],
            "correct": 0,
            "ev": {
                0: ["retry", "unverified", "khaali"],
                1: ["khaali hai", "aage badho"],
                2: ["approved ho gaye", "success declare"],
            },
            "required": ["retry", "unverified"],
        },
    ],
}


# ---------------------------------------------------------------------------
# grading (deterministic, rule-based — no network, no randomness)
# ---------------------------------------------------------------------------

def _read(skill: str) -> str | None:
    fn, _ = SKILLS[skill]
    p = os.path.join(KNOWLEDGE_DIR, fn)
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _hits(low: str, phrases: list[str]) -> int:
    return sum(1 for p in phrases if p.lower() in low)


def grade_question(low: str, q: dict) -> dict:
    """Ek MCQ grade karo. File ka 'jawab' = sabse zyada evidence wali choice.
    PASS iff: required phrases sab maujood + winner unique + winner == correct
    + winner ka evidence > 0."""
    required_missing = [p for p in q.get("required", []) if p.lower() not in low]
    n = len(q["choices"])
    scores = [_hits(low, q.get("ev", {}).get(i, [])) for i in range(n)]
    best = max(scores)
    winners = [i for i, s in enumerate(scores) if s == best]
    picked = winners[0]  # deterministic: pehla max
    passed = (not required_missing and len(winners) == 1
              and picked == q["correct"] and best > 0)
    return {
        "question_id": q["id"],
        "rule_id": q["rule"],
        "passed": passed,
        "picked": picked,
        "correct": q["correct"],
        "scores": scores,
        "required_missing": required_missing,
    }


def quiz_skill(skill: str) -> dict:
    """Ek skill ka quiz chalao. Returns
    {score, passed, total, failures, scenarios, details, version}."""
    failures: list[str] = []
    scenario_results: list[dict] = []
    details: list[dict] = []
    passed = 0
    total = 0

    def check(name: str, ok: bool):
        nonlocal passed, total
        total += 1
        if ok:
            passed += 1
        else:
            failures.append(name)

    if skill not in SKILLS:
        return {"score": 0.0, "passed": 0, "total": 0,
                "failures": [f"unknown skill: {skill}"],
                "scenarios": [], "details": [], "version": KNOWLEDGE_VERSION}

    text = _read(skill)
    check("file-exists", text is not None)
    if text is None:
        return {"score": 0.0, "passed": 0, "total": total,
                "failures": failures, "scenarios": scenario_results,
                "details": details, "version": KNOWLEDGE_VERSION}

    low = text.lower()
    check("has-mission", "## mission" in low)
    _, min_rules = SKILLS[skill]
    import re
    n_rules = len(re.findall(r"^###\s+R\d+\b", text, re.M))
    check(f"hard-rules>={min_rules} (mile {n_rules})", n_rules >= min_rules)
    n_good = len(re.findall(r"^###\s+G\d+\b", text, re.M))
    check(f"good-examples>=2 (mile {n_good})", n_good >= 2)
    n_bad = len(re.findall(r"^###\s+B\d+\b", text, re.M))
    check(f"bad-examples>=1 (mile {n_bad})", n_bad >= 1)
    check("has-escalation-triggers", "## escalation triggers" in low)

    for q in QUESTIONS.get(skill, []):
        g = grade_question(low, q)
        if g["passed"]:
            check(f"mcq:{q['id']}", True)
        else:
            why = []
            if g["required_missing"]:
                why.append(f"required missing {g['required_missing']}")
            why.append(f"picked={g['picked']} correct={g['correct']} "
                       f"scores={g['scores']}")
            check(f"mcq:{q['id']} ({'; '.join(why)})", False)
        scenario_results.append({
            "scenario_id": q["id"], "rule_id": q["rule"], "passed": g["passed"],
        })
        details.append({
            "question_id": q["id"],
            "rule_id": q["rule"],
            "question": q["q"],
            "choices": q["choices"],
            "correct": q["correct"],
            "picked": g["picked"],
            "passed": g["passed"],
        })

    score = round(passed / total, 3) if total else 0.0
    return {"score": score, "passed": passed, "total": total,
            "failures": failures, "scenarios": scenario_results,
            "details": details, "version": KNOWLEDGE_VERSION}


def run_quiz(skills=None) -> dict:
    """Saare (ya diye gaye) skills ka quiz.

    run_quiz()            -> {skill: result}   (agent_trainer.py yehi use karta hai)
    run_quiz("skill-key") -> single skill ka result dict {score, total, details, ...}
    run_quiz(["a", "b"])  -> subset ka {skill: result}
    """
    if isinstance(skills, str):
        return quiz_skill(skills)
    targets = list(skills) if skills else list(SKILLS)
    return {s: quiz_skill(s) for s in targets if s in SKILLS}


if __name__ == "__main__":
    res = run_quiz()
    for sk, r in res.items():
        flag = "PASS" if r["score"] >= QUIZ_GATE else "FAIL"
        print(f"[{flag}] {sk}: {r['score']} ({r['passed']}/{r['total']})")
        for f_ in r["failures"]:
            print(f"       - {f_}")
