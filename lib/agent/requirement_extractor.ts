/**
 * lib/agent/requirement_extractor.ts — requirements/brief ko structured
 * posting spec me badlo (2026-09-20, work package 3).
 *
 * PROBLEM: caption_template/hashtags kai rows me instruction fragments hain
 * ("exact caption" nahi) — galat caption = Whop reject. Pehle select-campaign
 * aise campaigns ko needs_phone bhej deta tha (user action), jabki zyada
 * cases me campaign samajh ke COMPLIANT caption generate kiya ja sakta hai.
 *
 * RULES:
 * - Field brief me EXACT diya hai → use wahi (generated:false).
 * - Field absent/placeholder hai → campaign understanding (product, audience,
 *   tone) se compliant value GENERATE karo, generated:true mark karo.
 * - HARD requirements (required footage / required moment jaise MoonPay ka
 *   "The Moment MoonPay Got Its Name" 05:53–06:52) KABHI invent mat karo —
 *   present-but-unresolved ho to hard_blocked=true → fail closed.
 *
 * Output select-campaign + planner notes me jata hai (full notes merge,
 * overwrite nahi).
 */

export interface CampaignReqInput {
  id: string;
  name: string | null;
  sponsor?: string | null;
  requirements?: string | null;
  caption_template?: string | null;
  hashtags?: string | null;
  notes?: Record<string, unknown> | null;
}

export interface Field<T> {
  value: T;
  /** true = brief me nahi tha, campaign understanding se banaya */
  generated: boolean;
  source: string;
}

export interface ExtractedRequirements {
  caption_template: Field<string>;
  hashtags: Field<string[]>;
  /** @mentions jo caption me hone chahiye */
  tags: Field<string[]>;
  logo_on_video: Field<boolean>;
  hook_rules: Field<string[]>;
  banned_content: Field<string[]>;
  /** required footage/moments — KABHI invent nahi hote */
  hard_requirements: string[];
  /** hard requirement present hai lekin resolve nahi hua → fail closed */
  hard_blocked: boolean;
  hard_block_reasons: string[];
  /** kuch campaigns IG bio me link mangte hain (manual step) */
  required_bio_link: Field<string | null>;
}

interface FullBrief {
  required_caption?: string;
  required_title?: string;
  required_hashtags?: string[];
  required_tags?: string[];
  required_overlay?: string;
  required_bio_link?: string;
  content_do?: string[];
  content_dont?: string[];
  official_sources?: string[];
  audience?: string;
  prohibited?: string[];
  [k: string]: unknown;
}

function fullBrief(c: CampaignReqInput): FullBrief {
  const n = c.notes;
  if (n && typeof n === "object") {
    const fb = (n as Record<string, unknown>).full_brief;
    if (fb && typeof fb === "object") return fb as FullBrief;
  }
  return {};
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
  if (typeof v === "string" && v.trim()) return v.split(/[,|\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

const PLACEHOLDER_RE = /\[.*(insert|your|here|brand|tag|product).*\]|<.*(insert|your|here).*>|TODO|TBD|coming soon/i;

/** ES5-safe: text se #hashtags nikalo (deduped). */
function hashTags(text: string): string[] {
  const re = /#(\w{2,})/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = "#" + m[1];
    if (out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

/** ES5-safe: text se @mentions nikalo (deduped). */
function atMentions(text: string): string[] {
  const re = /@([A-Za-z0-9_.]{3,})/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = "@" + m[1];
    if (out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

/** ES5-safe: "do not / don't / never / no ..." prohibitions nikalo. */
function noPatterns(text: string): string[] {
  const re = /(?:do not|don't|never|no)\s+([^.\n]{4,120})/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].trim().slice(0, 120);
    if (out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

/** Product/topic — campaign name se (clipping/campaign/UGC shor hata ke). */
function productOf(c: CampaignReqInput): string {
  const raw = (c.name || "").split("|")[0].trim();
  return raw
    .replace(/\b(clipping|campaign|ugc|clips?|army|official)\b/gi, "")
    .replace(/\$[\d.,kK]+\s*(budget|cpm)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "this";
}

function handleOf(c: CampaignReqInput): string {
  const fb = fullBrief(c);
  const tags = asList(fb.required_tags);
  for (const t of tags) {
    const m = t.match(/@([A-Za-z0-9_.]+)/);
    if (m) return "@" + m[1];
  }
  // requirements text me @handle
  const texts = [c.requirements || "", ...(asList(fb.content_do))];
  for (const t of texts) {
    const m = t.match(/@([A-Za-z0-9_.]{3,})/);
    if (m && !/gmail|email/i.test(t)) return "@" + m[1];
  }
  const p = productOf(c).split(/\s+/)[0].replace(/[^A-Za-z0-9_]/g, "");
  return p ? "@" + p.toLowerCase() : "@brand";
}

/**
 * Hard requirements detect karo — required footage / required moment /
 * "only X se" patterns. Ye KABHI generate nahi hote.
 */
function detectHard(c: CampaignReqInput, fb: FullBrief): { reqs: string[]; blocked: boolean; reasons: string[] } {
  const reqs: string[] = [];
  const reasons: string[] = [];
  const texts: string[] = [];
  if (c.requirements) texts.push(c.requirements);
  for (const k of ["content_do", "content_dont", "prohibited"] as const) {
    for (const s of asList(fb[k])) texts.push(s);
  }
  const joined = texts.join("\n");

  // required moment with timestamps: "05:53–06:52", "the moment X got its name"
  const momentRes = [
    /required\s+moment[^.\n]*/gi,
    /the\s+moment[^.\n]*\d{1,2}:\d{2}[^.\n]*/gi,
    /\bmust\s+use\b[^.\n]*footage[^.\n]*/gi,
    /\bonly\s+(from|use)\b[^.\n]*@/gi,
    /footage\s+only\s+from[^.\n]*/gi,
    /do\s+not\s+name[^.\n]*companies[^.\n]*/gi,
  ];
  for (const re of momentRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined)) !== null) {
      const s = m[0].trim().slice(0, 160);
      if (s && reqs.indexOf(s) < 0) reqs.push(s);
    }
  }
  // timestamp ranges jo moment specify karte hain
  const tsRe = /\b\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\b/g;
  let tm: RegExpExecArray | null;
  while ((tm = tsRe.exec(joined)) !== null) {
    const s = `required timestamp range ${tm[0]}`;
    if (reqs.indexOf(s) < 0) reqs.push(s);
  }

  // blocked = hard requirement hai lekin uska footage resolve nahi hua.
  // Yahan sirf detect karte hain; resolution asset_resolver karta hai.
  // Caller (select-campaign) asset + hard dono dekh ke decide karta hai.
  let blocked = false;
  for (const r of reqs) {
    if (/moment|timestamp|only\s+(from|use)|must\s+use/i.test(r)) {
      blocked = true;
      reasons.push(`hard requirement unresolved: "${r.slice(0, 100)}" — invent nahi karenge`);
    }
  }
  return { reqs, blocked, reasons };
}

export function extractRequirements(c: CampaignReqInput): ExtractedRequirements {
  const fb = fullBrief(c);
  const reqText = [c.requirements || "", ...asList(fb.content_do), ...asList(fb.content_dont)].join("\n");
  const product = productOf(c);
  const handle = handleOf(c);
  const audience = (typeof fb.audience === "string" && fb.audience.trim()) || "general audience";

  // ---- caption_template ----
  let capRaw = (typeof fb.required_caption === "string" && fb.required_caption.trim())
    || (c.caption_template || "").trim();
  let capGenerated = false;
  let capSource = "brief.required_caption";
  if (!capRaw || capRaw.length < 20 || PLACEHOLDER_RE.test(capRaw)) {
    if (!capRaw) capSource = "generated (brief me caption nahi tha)";
    else capSource = `generated (brief caption fragment/placeholder tha: "${capRaw.slice(0, 50)}…")`;
    // Campaign understanding se compliant caption: product + audience + tags.
    // Exact-template nahi hai to ye best-effort compliant draft hai.
    capRaw = `${product} — ${audience} ke liye 🔥\n\n${handle}`;
    capGenerated = true;
  } else if (typeof fb.required_caption !== "string") {
    capSource = "campaigns.caption_template";
  }

  // ---- hashtags ----
  let tags = asList(fb.required_hashtags);
  let tagsSource = "brief.required_hashtags";
  let tagsGenerated = false;
  if (tags.length === 0) {
    const fromCol = asList(c.hashtags);
    if (fromCol.length > 0) { tags = fromCol; tagsSource = "campaigns.hashtags"; }
    else {
      const fromText = hashTags(reqText);
      if (fromText.length > 0) { tags = fromText; tagsSource = "requirements text"; }
      else {
        const base = product.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "");
        tags = base ? [`#${base}`, "#clips", "#viral"] : ["#clips", "#viral"];
        tagsSource = "generated (brief me hashtags nahi the)";
        tagsGenerated = true;
      }
    }
  }

  // ---- @tags ----
  let at = asList(fb.required_tags);
  let atSource = "brief.required_tags";
  let atGenerated = false;
  if (at.length === 0) {
    const fromText = atMentions(reqText);
    const clean = fromText.filter((t) => !/gmail|email/i.test(t));
    if (clean.length > 0) { at = clean; atSource = "requirements text"; }
    else { at = [handle]; atSource = "generated (campaign handle se)"; atGenerated = true; }
  }

  // ---- logo_on_video ----
  const overlayText = [typeof fb.required_overlay === "string" ? fb.required_overlay : "", reqText].join("\n").toLowerCase();
  const logoVal = /logo/i.test(overlayText) ? !/no\s+logo|without\s+logo/i.test(overlayText) : false;
  const logoGen = !/logo/i.test(overlayText);

  // ---- hook_rules ----
  const hooks: string[] = [];
  for (const s of asList(fb.content_do)) {
    if (/hook|first|3\s*sec|title/i.test(s) && s.length < 200) hooks.push(s);
  }
  // Locked defaults (user-set posting standard — hamesha apply)
  const defaults = [
    "hook/title top edge se ≥10% neeche (safe zone)",
    "captions bottom/right IG UI zone se upar",
  ];
  const hookGenerated = hooks.length === 0;
  const hookVal = Array.from(new Set(hooks.concat(defaults)));

  // ---- banned_content ----
  const noRes = noPatterns(reqText);
  const banned = Array.from(new Set([
    ...asList(fb.content_dont),
    ...asList(fb.prohibited),
    ...noRes,
  ])).slice(0, 20);

  // ---- hard requirements ----
  const hard = detectHard(c, fb);

  // ---- required_bio_link ----
  const bioRaw = typeof fb.required_bio_link === "string" ? fb.required_bio_link.trim() : "";
  const bio: Field<string | null> = bioRaw
    ? { value: bioRaw, generated: false, source: "brief.required_bio_link" }
    : { value: null, generated: false, source: "none" };

  return {
    caption_template: { value: capRaw, generated: capGenerated, source: capSource },
    hashtags: { value: tags, generated: tagsGenerated, source: tagsSource },
    tags: { value: at, generated: atGenerated, source: atSource },
    logo_on_video: { value: logoVal, generated: logoGen, source: logoGen ? "default (brief me logo rule nahi)" : "brief.required_overlay/requirements" },
    hook_rules: { value: hookVal, generated: hookGenerated, source: hookGenerated ? "locked posting standard" : "brief.content_do + locked standard" },
    banned_content: { value: banned, generated: false, source: "brief.content_dont/prohibited/requirements" },
    hard_requirements: hard.reqs,
    hard_blocked: hard.blocked,
    hard_block_reasons: hard.reasons,
    required_bio_link: bio,
  };
}
