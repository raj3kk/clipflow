import Link from "next/link";
import { PublicHeader, PublicFooter } from "../components/PublicSite";

export const metadata = {
  title: "User Guide — AutoClip Kaise Chalaye (Step-by-Step)",
  description:
    "AutoClip user guide: APK install, device enroll, Instagram + Whop login, campaign Join, schedule/Run Now, app update — saaf Hinglish me, har step pe likha hai kya aapko karna hai aur kya automatic hai.",
  openGraph: {
    title: "AutoClip User Guide — Step-by-Step Hinglish",
    description:
      "APK install se lekar auto-update tak: har step pe saaf likha hai — YEH AAPKO KARNA HAI ya YEH AUTOMATIC HAI.",
    url: "https://clipflow-webbuilder1.vercel.app/guide",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ClipFlow — CF ribbon logo",
      },
    ],
  },
};

type Who = "aap" | "auto" | "dono";

interface Step {
  t: string;
  d: string[];
  who: Who;
  note?: string;
}

const whoBadge: Record<Who, { label: string; cls: string }> = {
  aap: {
    label: "👉 YEH AAPKO KARNA HAI",
    cls: "bg-amber-100 text-amber-800 border-amber-200",
  },
  auto: {
    label: "⚙️ YEH AUTOMATIC HAI",
    cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  dono: {
    label: "👉 + ⚙️ THODA AAP, BAAKI AUTO",
    cls: "bg-sky-100 text-sky-800 border-sky-200",
  },
};

const steps: Step[] = [
  {
    t: "AutoClip APK install karo (pehli baar)",
    who: "aap",
    d: [
      "Neeche wale “APK download karo” button se latest AutoClip APK download karo (Android phone pe).",
      "Install karte waqt phone poochhega “unknown apps install karne do?” — Allow kar dena (yeh normal hai, Play Store ke bahar ki app hai).",
      "App kholo — pehli screen pe hi aage ke steps dikhenge.",
    ],
    note: "Ek hi baar karna hai. Uske baad naye version app khud batayegi (step 7 dekho) — dobara website se dhoondhna nahi padega.",
  },
  {
    t: "Website pe account banao + phone enroll karo",
    who: "aap",
    d: [
      "ClipFlow website pe Signup karo (email + password), phir Login karo — Devices page khulega.",
      "Devices page pe “Enroll code banao” dabao — 6-digit code dikhega (10 minute valid).",
      "Phone pe AutoClip app kholo aur ye 6-digit code dalo — bas, phone website se jud gaya.",
    ],
    note: "Har phone ke liye ek baar. Code kisi ke saath share mat karo — ye aapke account se judta hai.",
  },
  {
    t: "App me Instagram login karo",
    who: "aap",
    d: [
      "App me Instagram section kholo aur apne clipping wale Instagram account se login karo (wahi account jahan reels post hongi).",
      "Login aapke phone me hi rehta hai — hum aapka password kabhi store nahi karte.",
      "Ek baar login ho gaya to mahino chalta hai. Agar Instagram kabhi logout kar de to app bata degi — dobara login kar dena.",
    ],
  },
  {
    t: "App me Whop login karo",
    who: "aap",
    d: [
      "App me Whop section kholo aur apne Whop account se login karo (wahi account jahan campaigns join karte ho).",
      "Instagram ki tarah ye login bhi phone me rehta hai, password store nahi hota.",
    ],
  },
  {
    t: "Whop pe campaign ka Join dabao",
    who: "aap",
    d: [
      "Website pe Campaigns page me dekho kaunsi campaign chal rahi hai (reward, views, requirements sab likha hai).",
      "Whop app/website kholo, us campaign pe “Join” dabao — bina Join kiye us campaign ki earning nahi milegi.",
    ],
    note: "⚠️ Abhi ye step manual hai. Naye app version (p20) me auto-join aa raha hai — uske baad campaign chunte hi phone khud Whop pe Join daba dega (YEH AUTOMATIC ho jayega). Tab tak har campaign pe Join aapko dabana hai.",
  },
  {
    t: "Schedule lagao ya Run Now dabao",
    who: "dono",
    d: [
      "Website pe campaign chuno aur time set karo (schedule) — ya turant shuru karne ke liye “Run Now” dabao. Din me max 4 runs.",
      "Uske baad sab AUTOMATIC: phone khud video download karega → 9:16 clip banayega → Instagram pe post karega → Whop pe submit karega.",
      "Live page pe dekh sakte ho kaam kahan tak pahuncha (download → edit → post → submit).",
    ],
    note: "Kab chalana hai ye faisla aapka hai (schedule/Run Now). Chalane ke baad kuch karne ki zaroorat nahi.",
  },
  {
    t: "App update aaye to 2 tap me install karo",
    who: "dono",
    d: [
      "App khud naya version check karti hai — khulne pe aur har ~6 ghante me.",
      "Naya version mile to “Naya update aaya hai” dialog dikhega: kya naya hai likha hoga. “Abhi update karo” dabao.",
      "APK download hogi (progress dikhega), phir Android ka system dialog khulega — wahan “Install” dabao. Bas!",
    ],
    note: "Kabhi “force update” aaye to bina update kiye app aage nahi badhegi — turant update kar lena. “Baad me” daboge to us version ka dialog dobara nahi dikhega.",
  },
];

const extra: { t: string; d: string }[] = [
  {
    t: "Coins kaise milte hain?",
    d: "App online rahegi to coins milte rahenge — ye reward points hain, inki koi cash value nahi hai.",
  },
  {
    t: "Post ruk gayi / action-block?",
    d: "Instagram kabhi-kabhi limit laga deta hai — aisa ho to automation khud 24 ghante ruk jayegi aur aapko batayegi. Jabardasti dobara mat chalao.",
  },
  {
    t: "Device offline dikhe?",
    d: "Pehle phone ka internet aur battery-saver check karo (battery saver app ko sone de deta hai). App kholo — khulne pe woh turant check karti hai.",
  },
  {
    t: "Kahi atak jao?",
    d: "Website me AI agent ka chat button dabao — woh step-by-step help karega.",
  },
];

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          AutoClip User Guide
        </h1>
        <p className="mt-2 text-sm text-slate-600 sm:text-base">
          Shuru se aakhir tak — 7 steps, simple Hinglish me. Har step pe saaf likha hai:{" "}
          <span className="font-semibold text-amber-700">kya aapko karna hai</span> aur{" "}
          <span className="font-semibold text-emerald-700">kya automatic hai</span>. Koi step chhupa nahi hai.
        </p>

        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:p-6">
          <h2 className="font-display text-base font-bold text-emerald-900">
            Step 1 yahin se shuru karo
          </h2>
          <p className="mt-1 text-sm text-emerald-800">
            Latest AutoClip APK download karo — ye link hamesha naye version pe le jayega.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <a
              href="/api/app/latest"
              className="rounded-xl bg-emerald-600 px-6 py-3 text-center text-sm font-bold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-95"
            >
              ⬇ APK download karo
            </a>
            <Link
              href="/signup"
              className="rounded-xl border border-emerald-300 bg-white px-6 py-3 text-center text-sm font-bold text-emerald-700 transition-all hover:bg-emerald-100 active:scale-95"
            >
              Website pe account banao
            </Link>
          </div>
        </div>

        <ol className="mt-8 grid gap-4">
          {steps.map((s, i) => {
            const b = whoBadge[s.who];
            return (
              <li
                key={s.t}
                className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="flex items-start gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-600 to-emerald-500 font-display text-base font-extrabold text-white shadow-sm">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <span
                      className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${b.cls}`}
                    >
                      {b.label}
                    </span>
                    <h2 className="mt-1.5 font-display text-lg font-bold text-slate-900">
                      {s.t}
                    </h2>
                    <ul className="mt-1.5 grid gap-1.5">
                      {s.d.map((line, j) => (
                        <li key={j} className="text-sm leading-relaxed text-slate-600">
                          • {line}
                        </li>
                      ))}
                    </ul>
                    {s.note ? (
                      <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                        {s.note}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <h2 className="mt-10 font-display text-xl font-bold text-slate-900">
          Aam sawaal
        </h2>
        <div className="mt-4 grid gap-3">
          {extra.map((e) => (
            <div
              key={e.t}
              className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
            >
              <h3 className="text-sm font-bold text-slate-900">{e.t}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{e.d}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:p-6">
          <h2 className="font-display text-base font-bold text-emerald-900">
            Yaad rakhne wali 3 baatein
          </h2>
          <ul className="mt-2 grid gap-1.5 text-sm text-emerald-800">
            <li>• Schedule/Run Now ke baad kuch karne ki zaroorat nahi — post aur submit automatic hai.</li>
            <li>• Instagram/Whop login ek baar karo — password hum kahin store nahi karte.</li>
            <li>• Naya app version aaye to 2 tap me update kar lo — website se APK dhoondhna nahi padega.</li>
          </ul>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
              className="rounded-xl bg-emerald-600 px-6 py-3 text-center text-sm font-bold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-95"
            >
              Login karke shuru karo
            </Link>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
