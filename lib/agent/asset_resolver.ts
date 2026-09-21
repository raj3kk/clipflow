/**
 * lib/agent/asset_resolver.ts — clip-stage asset resolution (2026-09-20, work package 3).
 *
 * PROBLEM: clip/download stage tabhi chal sakta hai jab campaign ka koi
 * RESOLVED, attributable footage/download link ho. Pehle selection sirf
 * "brief_url non-empty hai" dekhta tha — Google Doc brief, quarantined
 * patched YouTube link, ya substitute footage pe bhi clip ban jata tha.
 *
 * RESOLUTION ORDER (fail-closed):
 *   (a) phone-verified video links (verified_video_links) — sabse bharosa
 *   (b) brief_url — sirf agar usable ho (neeche)
 *   (c) requirements/notes text me scrape kiye gaye URLs
 *   (d) influencer identity → public lookup BINA login (YouTube @handle →
 *       channelId → public RSS feed) — attributable official asset
 *   (e) else → NOT clip-eligible (join_only)
 *
 * QUARANTINE: 2026-09-20 ke hub restore me 11 YouTube watch URLs brief_url
 * me patch ki gayi thi — authorization evidence (brand brief / phone
 * verification) kisi ke paas nahi. Jab tak authorization establish nahi
 * hota, ye URLs download ke liye BLOCKED hain. Authorization ke 2 raste:
 *   1. notes.verified_video_links me phone se verify ho jaye, ya
 *   2. official brief doc me wahi video ID listed mile.
 * Quarantine list me video-ID match hota hai (URL form se independent).
 *
 * KABHI render mat karo: unattributable / substitute footage se.
 * "Kuch to footage chahiye" wala shortcut fail-closed hai.
 */

export interface CampaignAssetInput {
  id: string;
  name: string | null;
  sponsor?: string | null;
  brief_url?: string | null;
  requirements?: string | null;
  campaign_url?: string | null;
  notes?: Record<string, unknown> | null;
}

export type AssetKind = "youtube" | "direct_file" | "drive_file" | "brief_doc" | null;
export type AssetSource =
  | "verified_links"
  | "brief_url"
  | "requirements_text"
  | "influencer_lookup"
  | "none";

export interface AssetResolution {
  /** clip stage is campaign ko pick kar sakta hai */
  eligible: boolean;
  /** resolved footage/download link (eligible=true pe non-null) */
  assetUrl: string | null;
  assetKind: AssetKind;
  source: AssetSource;
  /** official/branded source — substitute nahi */
  attributable: boolean;
  /** patched URL — authorization tak blocked */
  quarantined: boolean;
  reasons: string[];
}

/**
 * QUARANTINED YouTube video IDs — 2026-09-20 hub restore me brief_url me
 * patch hue, authorization evidence nahi. (Task me "10" bola gaya tha;
 * live DB check pe 11 mile — saare 11 quarantine me.)
 */
export const QUARANTINED_YOUTUBE_IDS = new Set([
  "4Abm4WrMNJQ", // hub-24ad Call of Duty
  "w_F0YTnadp8", // hub-1411 Social Commerce News
  "pYda8tcpfU4", // hub-efa2 Maxim Hair Restoration
  "N4tM9cFZouU", // hub-52c7 Ali-A Fortnite
  "spOmWw5ScDs", // hub-2e3e Graeme Holm
  "OWwbaCXdkeY", // hub-8684 Michael Sartain
  "mzhpUxknIP0", // hub-14f7 Yomi Denzel
  "uGHSFKgCBHg", // hub-ed90 DumbMoneyHunter
  "_wEzagimGjc", // hub-9e87 Charlie Berens
  "MfT5HXJLx1E", // hub-44a8 Abu Lahya
  "M6ldUVOyaz4", // hub-e509 Backyard Breaks
]);

const YT_ID_RE =
  /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function youtubeId(url: string): string | null {
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

function isQuarantined(url: string): boolean {
  const id = youtubeId(url);
  return !!id && QUARANTINED_YOUTUBE_IDS.has(id);
}

function kindOf(url: string): AssetKind {
  if (youtubeId(url)) return "youtube";
  if (/docs\.google\.com\/document/i.test(url)) return "brief_doc";
  if (/drive\.google\.com/i.test(url)) return "drive_file";
  if (/\.(mp4|mov|webm|mkv)(\?|$)/i.test(url)) return "direct_file";
  if (/supabase\.co\/storage/i.test(url)) return "direct_file";
  return null;
}

/** notes.verified_video_links — phone ne Whop page se nikale official links. */
function verifiedLinks(c: CampaignAssetInput): string[] {
  const n = c.notes;
  if (!n || typeof n !== "object") return [];
  const v = (n as Record<string, unknown>).verified_video_links;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is string => typeof x === "string" && /^https?:\/\//i.test(x.trim())
  ).map((x) => x.trim());
}

/** requirements + notes text me se candidate URLs nikalo (downloadable pehle). */
function scrapedUrls(c: CampaignAssetInput): string[] {
  const texts: string[] = [];
  if (c.requirements) texts.push(c.requirements);
  const n = c.notes;
  if (n && typeof n === "object") {
    const fb = (n as Record<string, unknown>).full_brief;
    if (fb && typeof fb === "object") {
      for (const v of Object.values(fb)) {
        if (typeof v === "string") texts.push(v);
        else if (Array.isArray(v))
          for (const x of v) if (typeof x === "string") texts.push(x);
      }
    }
    const vr = (n as Record<string, unknown>).verified_requirements;
    if (typeof vr === "string") texts.push(vr);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) {
    const matches = t.match(URL_RE) || [];
    for (const m0 of matches) {
      let u = m0.replace(/[.,;!?]+$/, "");
      // Google Docs edit URLs me &amp; entity aa sakti hai
      u = u.replace(/&amp;/g, "&");
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  // downloadable / attributable pehle
  const rank = (u: string) =>
    youtubeId(u) ? 0 : /\.(mp4|mov|webm|mkv)(\?|$)/i.test(u) ? 0 : /drive\.google\.com/i.test(u) ? 1 : 2;
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Sync resolution — (a) verified links, (b) brief_url, (c) text scrape.
 * Koi network nahi — har request pe safe.
 */
export function resolveCampaignAsset(c: CampaignAssetInput): AssetResolution {
  const reasons: string[] = [];
  const fail = (r: string): AssetResolution => ({
    eligible: false, assetUrl: null, assetKind: null, source: "none",
    attributable: false, quarantined: false, reasons: [...reasons, r],
  });

  // (a) phone-verified links
  const vl = verifiedLinks(c);
  for (const u of vl) {
    if (isQuarantined(u)) {
      reasons.push(`verified link quarantined hai (${youtubeId(u)}) — authorization baaki`);
      continue;
    }
    return {
      eligible: true, assetUrl: u, assetKind: kindOf(u) || "direct_file",
      source: "verified_links", attributable: true, quarantined: false,
      reasons: [...reasons, "phone-verified official link"],
    };
  }

  // (b) brief_url
  const brief = (c.brief_url || "").trim();
  if (brief && /^https?:\/\//i.test(brief)) {
    if (isQuarantined(brief)) {
      return {
        eligible: false, assetUrl: null, assetKind: "youtube",
        source: "none", attributable: false, quarantined: true,
        reasons: [...reasons,
          `brief_url quarantined patched YouTube ID hai (${youtubeId(brief)}) — ` +
          "authorization (brand brief / phone verification) tak download BLOCKED"],
      };
    }
    const k = kindOf(brief);
    if (k === "youtube" || k === "direct_file" || k === "drive_file") {
      return {
        eligible: true, assetUrl: brief, assetKind: k, source: "brief_url",
        attributable: true, quarantined: false,
        reasons: [...reasons, `brief_url usable (${k})`],
      };
    }
    if (k === "brief_doc") {
      // Google Doc khud footage nahi — official_sources me link dhoondho
      const n = c.notes;
      const fb = n && typeof n === "object"
        ? ((n as Record<string, unknown>).full_brief as Record<string, unknown> | undefined)
        : undefined;
      const srcs = fb && Array.isArray(fb.official_sources) ? fb.official_sources : [];
      for (const s of srcs) {
        if (typeof s !== "string" || !/^https?:\/\//i.test(s)) continue;
        if (isQuarantined(s)) continue;
        const sk = kindOf(s);
        if (sk === "youtube" || sk === "direct_file" || sk === "drive_file") {
          return {
            eligible: true, assetUrl: s, assetKind: sk, source: "brief_url",
            attributable: true, quarantined: false,
            reasons: [...reasons, "official brief doc ke official_sources se resolved"],
          };
        }
      }
      reasons.push("brief_url Google Doc hai (footage nahi) aur official_sources me koi usable link nahi");
    } else {
      reasons.push(`brief_url ka kind samajh nahi aaya (${brief.slice(0, 60)}…)`);
    }
  } else if (brief) {
    reasons.push("brief_url empty/placeholder hai");
  } else {
    reasons.push("brief_url nahi hai");
  }

  // (c) requirements/notes text scrape
  for (const u of scrapedUrls(c)) {
    if (isQuarantined(u)) {
      reasons.push(`scraped URL quarantined hai (${youtubeId(u)}) — skip`);
      continue;
    }
    const k = kindOf(u);
    if (k === "youtube" || k === "direct_file" || k === "drive_file") {
      return {
        eligible: true, assetUrl: u, assetKind: k, source: "requirements_text",
        attributable: true, quarantined: false,
        reasons: [...reasons, `requirements/notes text se scraped (${k})`],
      };
    }
  }

  return fail("koi resolved asset link nahi (verified/brief/scraped sab fail)");
}

/** Campaign name se influencer handle candidates nikalo. */
function handleCandidates(name: string | null): string[] {
  if (!name) return [];
  let base = name
    .split("|")[0]
    .replace(/\b(clipping|campaign|ugc|clips?|army)\b/gi, "")
    .replace(/\$[\d.,kK]+\s*(budget|cpm)?/gi, "")
    .trim();
  const cands: string[] = [];
  const nospace = base.replace(/[^A-Za-z0-9_-]/g, "");
  if (nospace.length >= 3) cands.push(nospace);
  const first = base.split(/[\s_-]+/)[0]?.replace(/[^A-Za-z0-9_]/g, "");
  if (first && first.length >= 3 && !cands.includes(first)) cands.push(first);
  const two = base.split(/[\s_-]+/).slice(0, 2).join("").replace(/[^A-Za-z0-9_]/g, "");
  if (two.length >= 4 && !cands.includes(two)) cands.push(two);
  return cands.slice(0, 3);
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!/text|xml|rss/i.test(ct)) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Brief Google Doc ka plain text nikalo (public export, timeout-guarded).
 * Brand ka apna brief doc hai — isme @handle mentions official hote hain.
 */
async function fetchBriefDocText(
  briefUrl: string | null | undefined,
  timeoutMs: number
): Promise<string | null> {
  if (!briefUrl) return null;
  const m = briefUrl.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  return fetchText(
    `https://docs.google.com/document/d/${m[1]}/export?format=txt`,
    timeoutMs
  );
}

/** Doc text se @handle mentions nikalo (creator ka official handle). */
function docHandleCandidates(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /(^|[\s("'])@([A-Za-z][A-Za-z0-9_.-]{1,28})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = m[2].replace(/[.-]+$/, "");
    if (h.length >= 3 && !out.includes(h)) out.push(h);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * (d) Influencer public lookup — BINA login.
 * YouTube @handle page se channelId nikalo → public RSS feed se latest
 * videos → campaign keywords se match. Attributable official asset milta
 * hai (influencer ka apna channel). NOTE: ye brief-required MOMENT ko
 * replace NAHI karta — hard moment requirements render time pe fail-closed
 * rehte hain (requirement_extractor.hard_requirements).
 *
 * 2026-09-21: handle candidates sirf campaign naam se nahi — brief Google
 * Doc ke text se @mentions bhi (doc me "@MacMula" jaise official handles
 * hote hain). Campaign-naam se match karne wale handles pehle try hote
 * hain (misattribution risk kam).
 */
export async function resolveCampaignAssetDeep(
  c: CampaignAssetInput,
  timeoutMs = 8000
): Promise<AssetResolution> {
  const sync = resolveCampaignAsset(c);
  if (sync.eligible) return sync;

  const keywords = (c.name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !/clipping|campaign|budget|official/.test(w))
    .slice(0, 6);

  // 2026-09-21: brief doc se official @handles bhi candidate banao.
  // Doc-text handles + naam-derived handles, dedup; naam-token se match
  // karne wale doc handles pehle (agency handles baad me).
  const nameTokens = (c.name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  const docText = await fetchBriefDocText(c.brief_url, 5000);
  const docHandles = docHandleCandidates(docText).sort((a, b) => {
    const score = (h: string) =>
      nameTokens.some((t) => h.toLowerCase().includes(t)) ? 0 : 1;
    return score(a) - score(b);
  });
  const handles: string[] = [];
  for (const h of [...docHandles, ...handleCandidates(c.name)]) {
    if (!handles.includes(h)) handles.push(h);
  }

  for (const handle of handles) {
    const page = await fetchText(`https://www.youtube.com/@${handle}`, timeoutMs);
    if (!page) continue;
    const ch = page.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/);
    if (!ch) continue;
    const channelId = ch[1];
    const rss = await fetchText(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      timeoutMs
    );
    if (!rss) continue;
    const entryRe = /<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]*)<\/title>/g;
    const entries: Array<{ id: string; title: string }> = [];
    let em: RegExpExecArray | null;
    while ((em = entryRe.exec(rss)) !== null) {
      entries.push({ id: em[1], title: em[2] || "" });
      if (entries.length > 25) break;
    }
    if (entries.length === 0) continue;
    // keyword match wala pehla video, warna latest
    let pick = entries[0];
    for (const e of entries) {
      const title = e.title.toLowerCase();
      if (keywords.some((k) => title.includes(k))) { pick = e; break; }
    }
    const url = `https://www.youtube.com/watch?v=${pick.id}`;
    if (isQuarantined(url)) continue;
    return {
      eligible: true,
      assetUrl: url,
      assetKind: "youtube",
      source: "influencer_lookup",
      attributable: true,
      quarantined: false,
      reasons: [
        ...sync.reasons,
        `influencer public lookup: @${handle} → channel ${channelId.slice(0, 12)}… → "${pick.title.slice(0, 60)}"`,
        "NOTE: official channel ka video hai (attributable), lekin brief-required MOMENT nahi — hard moment rules render pe fail-closed",
      ],
    };
  }
  return {
    ...sync,
    reasons: [
      ...sync.reasons,
      `influencer public lookup: ${handles.length} handle(s) tried ` +
        `(${handles.slice(0, 4).join(", ")}${handles.length > 4 ? "…" : ""}` +
        `${docHandles.length > 0 ? ", doc se" : ""}) — koi official channel/video nahi mila`,
    ],
  };
}
