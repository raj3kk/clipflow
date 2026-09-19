/**
 * ClipFlow AI Agent — knowledge base (₹0, koi external LLM nahi).
 *
 * Intent-based jawab, Hinglish me. Safety:
 * - Agent sirf padhta hai / batata hai — khud se run/post/delete KABHI nahi karta.
 * - Destructive cheezon (delete/disconnect) pe sirf sahi page ka link + confirm ki salah.
 * - "dusre ka account / password batao" jaise sawalon pe seedha mana.
 */

export type IntentId =
  | "danger"
  | "greeting"
  | "guide_schedule"
  | "guide_enroll"
  | "run_now_info"
  | "live"
  | "earnings"
  | "schedule_info"
  | "enroll"
  | "offline"
  | "battery"
  | "login_help"
  | "cap"
  | "delete_device"
  | "pause"
  | "trouble"
  | "app_install"
  | "who"
  | "unknown";

export type GuideTopic = "schedule" | "enroll";

export interface AgentLink {
  label: string;
  href: string;
}

export interface IntentResult {
  id: IntentId;
  /** static jawab; live/earnings/offline ke liye route data se compose karta hai */
  text: string;
  link?: AgentLink;
  /** chat me "Abhi Run Karo" ka hint dikhao */
  showRunNow?: boolean;
  suggestions?: string[];
  /** route ko user ka real data chahiye */
  needsOverview?: boolean;
  startGuide?: GuideTopic;
}

export interface GuideState {
  topic: GuideTopic;
  step: number; // 0-based
}

export interface OverviewData {
  devices: {
    id: string;
    device_name: string;
    presence: "online" | "idle" | "offline";
    status: string;
    last_seen: string | null;
  }[];
  activeJobs: {
    device_name: string;
    type: string;
    status: string;
    created_at: string;
  }[];
  recentRuns: { status: string; finished_at: string; note: string }[];
  submissions: {
    campaign_name: string | null;
    whop_status: string | null;
    submitted_at: string;
  }[];
}

/* ---------------- guide flows: ek step confirm → agla step ---------------- */

export const GUIDES: Record<
  GuideTopic,
  { title: string; steps: string[]; done: string }
> = {
  schedule: {
    title: "Schedule lagana",
    steps: [
      "**Step 1:** Neeche **Devices** page kholo aur apne phone ke card me **Schedule** editor kholo.",
      "**Step 2:** Time chuno — kab clip post karna hai. Yaad rakho: ek din me **max 4 run**, aur do run ke beech **kam se kam 4 ghante** ka gap.",
      "**Step 3:** **Clip package** bharo — video URL + caption + Whop submit URL. Bina iske Run Now kaam nahi karega.",
      "**Step 4:** **Save** dabao — schedule set ho gaya!",
    ],
    done: "Ho gaya! Ab phone online rakho — time pe automatic chalega. Test karna ho to isi chat me **Abhi Run Karo** dabao. Kuch aur puchna ho to bolo.",
  },
  enroll: {
    title: "Device enroll karna",
    steps: [
      "**Step 1:** Phone pe **AutoClip** app install karo. APK ka link Devices page pe milega.",
      "**Step 2:** Website pe **Devices** page kholo → **Enroll code** banao — 8 akshar ka code milega.",
      "**Step 3:** App me wahi code daalo — device jud jayega.",
      "**Step 4:** App me **Whop** aur **Instagram** — dono me login karo. Dono zaroori hain.",
      "**Step 5:** Phone ki **battery optimization OFF** karo (mujhse 'battery' pucho, steps bata dunga) taaki app background me chalti rahe.",
    ],
    done: "Device jud gaya! Ab schedule lagao ya **Abhi Run Karo** dabao. Kuch aur puchna ho to bolo.",
  },
};

const SUGGESTIONS_MAIN = [
  "Abhi kya chal raha hai?",
  "Device enroll kaise karu?",
  "Coins kaise milte hain?",
  "Mujhe schedule lagana hai",
];

/* ---------------- static intent texts (Hinglish) ---------------- */

function kb(): { test: RegExp; build: () => IntentResult }[] {
  const R = (id: IntentId, text: string, extra?: Partial<IntentResult>): IntentResult => ({
    id,
    text,
    suggestions: SUGGESTIONS_MAIN,
    ...extra,
  });

  return [
    // ---- safety: khatarnak / galat command → seedha mana ----
    {
      test: /dusre ka|doosre ka|kisi aur ka|dusra account|password batao|password do|otp batao|hack|bina login|bina permission|chori|steal/i,
      build: () =>
        R(
          "danger",
          "Ye main nahi kar sakta. Main sirf **aapke apne account** ka data dekhta hoon — dusre ka account dekhna, password/OTP batana ya bhej na, ye sab mere bas ke bahar hai aur galat bhi hai.\n\nApne account se judi koi cheez ho to batao, main madad karunga."
        ),
    },
    // ---- greeting ----
    {
      test: /^(namaste|hello|hi+|hey|salaam|ram ram|namaskar|yo|good (morning|evening|afternoon)|sup)\b/i,
      build: () =>
        R(
          "greeting",
          "Namaste! Main **ClipFlow Agent** hoon — clipping automation me aapki madad ke liye.\n\nMujhse pucho:\n• Abhi kya chal raha hai?\n• Coins kaise milte hain?\n• Device enroll / schedule kaise lagau?\n\nBolke bhi baat kar sakte ho — mic dabao. Jawab sunna ho to speaker on kar lo.",
          { suggestions: SUGGESTIONS_MAIN }
        ),
    },
    // ---- guide mode ----
    {
      test: /mujhe schedule lagana|schedule lagana hai|schedule sikha|step by step|guide chahiye|saath chal|guide karo/i,
      build: () =>
        R("guide_schedule", "", {
          startGuide: "schedule",
          suggestions: ["Ho gaya, agla step", "Guide band karo"],
        }),
    },
    {
      test: /enroll guide|device jodna sikha|enroll sikha/i,
      build: () =>
        R("guide_enroll", "", {
          startGuide: "enroll",
          suggestions: ["Ho gaya, agla step", "Guide band karo"],
        }),
    },
    // ---- run now ----
    {
      test: /abhi run|run now|turant chalao|abhi chalao|abhi post|abhi shuru|foran chalao/i,
      build: () =>
        R(
          "run_now_info",
          "**Abhi Run Karo** dabate hi poora pipeline chal padta hai — campaign → clip → Instagram post → Whop submit, sab automatic.\n\nShart: device ke **Clip package** (video URL + caption + Whop URL) pehle se set hona chahiye, aur device **online** hona chahiye.\n\nMain khud run nahi karta — neeche **Abhi Run Karo** button hai, dabao to confirm puchunga, phir hi chalega.",
          { showRunNow: true, link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- live status (real data) ----
    {
      test: /abhi kya chal|kya ho raha|live status|current status|^status|job chal raha|abhi ka haal/i,
      build: () => R("live", "", { needsOverview: true }),
    },
    // ---- earnings / coins ----
    {
      test: /coin|earning|kamai|paise|kitna mila|reward|paisa/i,
      build: () => R("earnings", "", { needsOverview: true }),
    },
    // ---- schedule info ----
    {
      test: /schedule|kab post hoga|kitne baje|time set|timing/i,
      build: () =>
        R(
          "schedule_info",
          "Schedule device ke card me **Schedule editor** se lagta hai (Devices page).\n\n• Ek din me **max 4 run** (rolling 24 ghante)\n• Do run ke beech **kam se kam 4 ghante** ka gap\n• Schedule time pe phone **online** hona chahiye\n\nStep-by-step chahiye to bolo — **\"mujhe schedule lagana hai\"**."
          ,
          { link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- enroll ----
    {
      test: /enroll|device add|naya phone|phone jod|connect.*phone|code kahan|8.*code/i,
      build: () =>
        R(
          "enroll",
          "Device enroll karna aasan hai:\n\n**1.** Phone pe **AutoClip** app install karo\n**2.** Website pe **Devices** page → **Enroll code** banao (8 akshar ka code)\n**3.** App me code daalo — device jud jayega\n**4.** App me **Whop + Instagram** login karo\n**5.** Battery optimization OFF karo\n\nSaath-saath karna ho to bolo — **\"enroll guide\"**.",
          { link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- offline ----
    {
      test: /offline|device nahi dikh|phone band|connect nahi|last seen|dikhai nahi de raha/i,
      build: () => R("offline", "", { needsOverview: true }),
    },
    // ---- battery ----
    {
      test: /battery|doze|background me|so jata|band ho jata|auto.?start/i,
      build: () =>
        R(
          "battery",
          "Phone ki battery setting sabse common wajah hai jab app background me band ho jati hai:\n\n**1.** Settings → Apps → **AutoClip** → Battery → **Unrestricted** (ya \"Don't optimize\")\n**2.** \"Allow background activity\" **ON** karo\n**3.** Xiaomi/Oppo/Vivo me: Auto-start **ON** karo\n**4.** Recent apps me AutoClip pe **lock** lagao (swipe-lock)\n**5.** Data Saver / Battery Saver me AutoClip ko **exclude** karo\n\nBina FCM ke phone har ~15 min me server check karta hai — thoda delay normal hai."
        ),
    },
    // ---- whop/ig login ----
    {
      test: /whop.*login|login.*whop|instagram.*login|login.*instagram|ig login|sign ?in|log ?in/i,
      build: () =>
        R(
          "login_help",
          "Login **AutoClip app me** hota hai, website pe nahi:\n\n**1.** App kholo → **Whop** me login karo (apna Whop account)\n**2.** Phir **Instagram** me login karo (wahi account jisme post karna hai)\n**3.** Dono login ke baad hi Run Now / schedule kaam karega\n\nLogin expire ho jaye to app me dobara login karo — website pe kuch nahi karna."
        ),
    },
    // ---- cap ----
    {
      test: /\bcap\b|limit|kitni baar|max.*run|4 run|block/i,
      build: () =>
        R(
          "cap",
          "Limits:\n\n• **Max 4 automation run** — rolling 24 ghante me, per device\n• Do run ke beech **kam se kam 4 ghante** ka gap\n• Instagram ne **action-block** kiya to device **24 ghante auto-pause** — isme retry nahi hota, wait karna padta hai"
        ),
    },
    // ---- delete / disconnect (destructive: agent khud NAHI karega) ----
    {
      test: /delete|disconnect|hatao|remove.*device|device.*hatao/i,
      build: () =>
        R(
          "delete_device",
          "Main khud device delete/disconnect **nahi kar sakta** — ye aapko khud karna hoga:\n\n**Devices** page pe apne device card me **\"Device hatao\"** button hai — wahan double-confirm karke hata sakte ho. Galti se na ho, isiliye do baar puchta hai.\n\nPakka karna hai to page kholo:",
          { link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- pause ----
    {
      test: /pause|rok do|roko|band karo|stop karo/i,
      build: () =>
        R(
          "pause",
          "Device pause karne ke liye **Devices** page pe device card ka **Online/Offline** toggle dabao. Pause me koi job nahi milega; wapas **Online** karne pe automation phir chalegi.\n\nMain khud pause nahi karta — button aapko dabana hoga:",
          { link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- app install ----
    {
      test: /autoclip|apk|app kahan|app download|install.*app/i,
      build: () =>
        R(
          "app_install",
          "**AutoClip** hamari Android app hai — yehi phone pe post + submit karti hai.\n\nAPK ka link **Devices** page pe milta hai. Install ke baad enroll code se jodo, phir Whop + Instagram login karo.\n\nDhyan rahe: **Android hi** supported hai — iPhone pe nahi chalega.",
          { link: { label: "Devices page kholo", href: "/devices" } }
        ),
    },
    // ---- troubleshooting ----
    {
      test: /error|fail|kaam nahi|problem|dikkat|galti|atka|nahi chal raha|kaam nahi kar raha/i,
      build: () =>
        R(
          "trouble",
          "Sabse pehle ye check karo:\n\n**1.** **Live** page dekho — job kahan atka (Devices → Live tab)\n**2.** Phone **online** hai? (last seen 5 min ke andar)\n**3.** App me **Whop + Instagram** login abhi bhi valid hai?\n**4.** **Battery optimization OFF** hai?\n**5.** Clip package (video URL + caption + Whop URL) set hai?\n\nPhir bhi na bane to error ka **screenshot** lo aur exact step batao — main aage guide karunga.",
          { link: { label: "Live status dekho", href: "/devices/live" } }
        ),
    },
    // ---- who ----
    {
      test: /tum kaun|kaun ho|insaan ho|human|support|owner se baat/i,
      build: () =>
        R(
          "who",
          "Main **ClipFlow Agent** hoon — isi website ka madadgar, insaan nahi. Clipping automation ke sawalon me madad karta hoon: enroll, schedule, coins, troubleshooting.\n\nJo cheez mere bas ki nahi (jaise dusre ka account, payment, ya naya feature), wo main saaf mana kar dunga."
        ),
    },
  ];
}

const KB = kb();

export function matchIntent(raw: string): IntentResult {
  const msg = raw.trim();
  for (const entry of KB) {
    if (entry.test.test(msg)) {
      entry.test.lastIndex = 0;
      return entry.build();
    }
  }
  return {
    id: "unknown",
    text: "Ye mujhe nahi pata. Main sirf ClipFlow clipping (enroll, schedule, Run Now, coins, troubleshooting) me madad karta hoon.\n\nDetail guide yahan dekho:",
    link: { label: "Guide page kholo", href: "/guide" },
    suggestions: SUGGESTIONS_MAIN,
  };
}

/* ---------------- guide step machine ---------------- */

const DONE_RE = /ho gaya|hogaya|done|agla|age badho|next|haan|yes|ok|kar diya/i;
const BACK_RE = /pichla|pichhe|back|wapas/i;
const STOP_RE = /band karo|stop|niklo|guide band|radd/i;

export function guideReply(
  state: GuideState,
  msg: string
): { text: string; guide: GuideState | null; done: boolean; link?: AgentLink } {
  const g = GUIDES[state.topic];
  if (STOP_RE.test(msg)) {
    return { text: "Guide band kar diya. Kuch aur puchna ho to bolo.", guide: null, done: true };
  }
  if (BACK_RE.test(msg)) {
    const step = Math.max(0, state.step - 1);
    return {
      text: g.steps[step],
      guide: { topic: state.topic, step },
      done: false,
      link: state.topic === "schedule" || state.topic === "enroll" ? { label: "Devices page kholo", href: "/devices" } : undefined,
    };
  }
  if (DONE_RE.test(msg) || state.step < 0) {
    const next = state.step + 1;
    if (next >= g.steps.length) {
      return { text: g.done, guide: null, done: true, link: { label: "Devices page kholo", href: "/devices" } };
    }
    return {
      text: g.steps[next],
      guide: { topic: state.topic, step: next },
      done: false,
      link: { label: "Devices page kholo", href: "/devices" },
    };
  }
  // sawal ya kuch aur — wahi step repeat karo
  return {
    text: `${g.steps[state.step]}\n\nYe step ho jaye to **\"ho gaya\"** likho, main agla step dunga.`,
    guide: state,
    done: false,
    link: { label: "Devices page kholo", href: "/devices" },
  };
}

export function startGuide(topic: GuideTopic): { text: string; guide: GuideState; link: AgentLink } {
  const g = GUIDES[topic];
  return {
    text: `**Guide: ${g.title}** — ek-ek step karte hain.\n\n${g.steps[0]}\n\nHo jaye to **\"ho gaya\"** likho.`,
    guide: { topic, step: 0 },
    link: { label: "Devices page kholo", href: "/devices" },
  };
}

/* ---------------- real-data replies (route overview se bharta hai) ---------------- */

function ago(iso: string | null): string {
  if (!iso) return "kabhi nahi";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "abhi-abhi";
  if (mins < 60) return `${mins} min pehle`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} ghante pehle`;
  return `${Math.floor(h / 24)} din pehle`;
}

export function composeLiveReply(d: OverviewData): string {
  const lines: string[] = [];
  if (d.devices.length === 0) {
    return "Abhi **koi device enroll nahi** hai. Pehle AutoClip app se device jodo, phir main live status bata paunga.\n\nBolo — **\"device enroll kaise karu?\"**";
  }
  for (const dev of d.devices) {
    const dot = dev.presence === "online" ? "🟢" : dev.presence === "idle" ? "🟡" : "🔴";
    lines.push(`${dot} **${dev.device_name}** — ${dev.presence} (last seen: ${ago(dev.last_seen)})`);
  }
  let out = `**Abhi ka haal:**\n\n${lines.join("\n")}`;
  if (d.activeJobs.length > 0) {
    out += `\n\n**Chal rahe jobs (${d.activeJobs.length}):**\n`;
    out += d.activeJobs
      .slice(0, 5)
      .map((j) => `• ${j.device_name} — ${j.type} (${j.status})`)
      .join("\n");
  } else {
    out += "\n\nAbhi **koi job nahi chal raha** — sab shaant hai.";
  }
  if (d.recentRuns.length > 0) {
    const last = d.recentRuns[0];
    out += `\n\nAakhri run: **${last.status}** (${ago(last.finished_at)})${last.note ? ` — ${last.note}` : ""}`;
  }
  return out;
}

export function composeEarningsReply(d: OverviewData): string {
  const n = d.submissions.length;
  let out = `**Coins kaise milte hain:**\n\n• Post ke **10 min** me → **100 coins**\n• Post ke **2 ghante** me → **1000 coins**\n• Post ke **4 ghante** me → **3000 coins**\n\nCoins = reward points hain, **cash value nahi** hai. Jaldi submit karo, zyada coins pao.`;
  if (n === 0) {
    out += "\n\nAapki abhi **koi submission nahi** hai — pehla clip post karke submit karo.";
  } else {
    const ok = d.submissions.filter((s) => (s.whop_status ?? "").toLowerCase() === "submitted" || (s.whop_status ?? "").toLowerCase() === "accepted").length;
    const last = d.submissions[0];
    out += `\n\n**Aapki submissions:** ${n} total${ok ? `, ${ok} submit ho gayi` : ""}. Aakhri: ${last.campaign_name ?? "campaign"} — ${ago(last.submitted_at)}.`;
  }
  return out;
}

export function composeOfflineReply(d: OverviewData): string {
  if (d.devices.length === 0) {
    return "Koi device enroll nahi hai. **\"device enroll kaise karu?\"** pucho, main guide karunga.";
  }
  const off = d.devices.filter((x) => x.presence !== "online");
  if (off.length === 0) {
    return "Sab devices **online** hain — koi offline nahi. Kuch aur dikkat hai to batao.";
  }
  let out = "**Offline/dheele devices:**\n\n";
  out += off
    .map((x) => `• **${x.device_name}** — ${x.presence}, last seen ${ago(x.last_seen)}`)
    .join("\n");
  out += "\n\n**Kya karo:**\n1. Phone me AutoClip kholo — app band to nahi?\n2. Internet on hai?\n3. Battery optimization OFF hai? (mujhse **\"battery\"** pucho)\n4. App me dobara Whop/Instagram login chahiye to nahi?\n\nBina FCM ke phone har ~15 min me check karta hai — thoda delay normal hai.";
  return out;
}
