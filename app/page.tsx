import Link from "next/link";
import { PublicHeader, PublicFooter, GoldPill } from "./components/PublicSite";

export const metadata = {
  title: "Apne Phone Se Clipping Automate Karo",
  description:
    "ClipFlow + AutoClip app: app install karo, campaign chuno, phone khud Instagram pe post karega. Schedule, Run Now, live tracking aur coin rewards — sab free.",
  openGraph: {
    title: "ClipFlow — Apne Phone Se Clipping Automate Karo",
    description:
      "App install karo, campaign chuno, phone khud post karega. Online time par coins kamao.",
    url: "https://clipflow-webbuilder1.vercel.app/",
  },
};

/* ---------- tiny inline icons ---------- */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const steps = [
  {
    n: "1",
    t: "AutoClip app install karo",
    d: "APK download karke apne Android phone pe install karo. Account banao aur website se 8-char code link karo.",
    icon: "M12 18v-6m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3",
  },
  {
    n: "2",
    t: "Campaign chuno, schedule lagao",
    d: "Website pe clipping campaign chuno, post ka time schedule karo — ya turant post ke liye Run Now dabao.",
    icon: "M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z",
  },
  {
    n: "3",
    t: "Phone khud post karega",
    d: "App apne aap login karke reel post karegi, link submit karegi — aur aap live tab me sab track kar sakte ho.",
    icon: "M5 13l4 4L19 7",
  },
];

const features = [
  {
    t: "Auto Schedule",
    d: "Apne time pe posting ka schedule lagao. Phone bina chhue apne aap post karega.",
    icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    t: "Run Now",
    d: "Wait nahi karna? Ek tap me turant post start karo.",
    icon: "M13 10V3L4 14h7v7l9-11h-7z",
  },
  {
    t: "Coin Rewards",
    d: "Phone jitna online rahega, utne coins. 10 min par 100 coins se lekar 4 ghante par 3000 coins tak.",
    icon: "M12 8c-1.66 0-3 .89-3 2s1.34 2 3 2 3 .89 3 2-1.34 2-3 2m0-8c1.11 0 2.08.4 2.6 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.4-2.6-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    t: "Live Tracking",
    d: "Konsa post kab hua, phone online hai ya nahi — Live tab me sab real-time me dekho.",
    icon: "M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.05 12a10 10 0 0119.9 0 10 10 0 01-19.9 0z",
  },
];

const faqs = [
  {
    q: "Kya mera phone poora din on rakhna padega?",
    a: "Phone usi time online hona chahiye jab post hona hai — schedule ke hisaab se. Coins bhi phone ke online time ke hisaab se milte hain, isliye zyada online time = zyada coins.",
  },
  {
    q: "Kya mera Instagram account safe hai?",
    a: "App aapke apne account se post karti hai. Instagram aur Whop ke niyam follow karna aapki zimmedari hai — koi galat step ya spam se account pe action ho, to uski zimmedari humari nahi hogi.",
  },
  {
    q: "Kya isme paise lagenge?",
    a: "Nahi. App aur website dono bilkul free hain. Koi payment hai hi nahi.",
  },
  {
    q: "Coins ka kya fayda? Kya ye paise me badlenge?",
    a: "Coins sirf reward points hain — inki koi cash value nahi hai aur inhe paise me nahi badla ja sakta. Future me token listing ka plan hai (Hamster Kombat/Dogs jaisa), lekin ye sirf ek plan hai — koi promise nahi.",
  },
  {
    q: "Run Now aur Schedule me kya farq hai?",
    a: "Schedule ka matlab hai post fix time pe hoga (roz ya ek baar). Run Now ka matlab hai abhi — ek tap me turant post start ho jayega.",
  },
  {
    q: "Agar kuch gadbad ho jaye to?",
    a: "Website me AI agent ka chat button hai — wahi poochho, woh step-by-step help karega. Ya phir Guide page pe saare steps likhe hain.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PublicHeader />

      {/* ================= HERO ================= */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-200/40 blur-3xl"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-14 text-center sm:px-6 sm:pt-20">
          <div className="animate-floaty mx-auto mb-6 h-28 w-28 overflow-hidden rounded-3xl bg-white shadow-lg ring-1 ring-slate-200 sm:h-32 sm:w-32">
            <img src="/brand-cf.webp" alt="ClipFlow CF logo" className="h-full w-full object-contain" />
          </div>
          <GoldPill>AutoClip app · Free</GoldPill>
          <h1 className="mx-auto mt-4 max-w-3xl font-display text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl md:text-6xl">
            Apne phone se{" "}
            <span className="bg-gradient-to-r from-emerald-600 to-amber-600 bg-clip-text text-transparent">
              clipping automate karo
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
            App install karo, campaign chuno, schedule lagao — baaki kaam phone khud karega:
            reel post, link submit, live tracking. Aur online time par coins kamao.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="w-full rounded-xl bg-emerald-600 px-7 py-3.5 text-base font-bold text-white shadow-md transition-all hover:bg-emerald-700 hover:shadow-lg active:scale-95 sm:w-auto"
            >
              Free me shuru karo
            </Link>
            <Link
              href="/guide"
              className="w-full rounded-xl border border-slate-300 bg-white px-7 py-3.5 text-base font-bold text-slate-800 shadow-sm transition-all hover:border-emerald-400 hover:text-emerald-700 active:scale-95 sm:w-auto"
            >
              Guide dekho
            </Link>
          </div>
        </div>
      </section>

      {/* ================= KAISE KAAM KARTA HAI ================= */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-center font-display text-2xl font-bold text-slate-900 sm:text-3xl">
          Kaise kaam karta hai
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-slate-500 sm:text-base">
          Sirf 3 simple steps — koi technical knowledge nahi chahiye.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                  <Icon d={s.icon} />
                </span>
                <span className="font-display text-3xl font-extrabold text-emerald-200">{s.n}</span>
              </div>
              <h3 className="mt-4 font-display text-lg font-bold text-slate-900">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ================= FEATURES ================= */}
      <section className="border-y border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-center font-display text-2xl font-bold text-slate-900 sm:text-3xl">
            Sab kuch auto, sab kuch track
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div
                key={f.t}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 transition-all hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-emerald-600 to-emerald-500 text-white shadow-sm">
                  <Icon d={f.icon} />
                </span>
                <h3 className="mt-3 font-display text-base font-bold text-slate-900">{f.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= COINS ================= */}
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="overflow-hidden rounded-3xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-emerald-50 p-6 shadow-sm sm:p-10">
          <div className="flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-xl">
              <GoldPill>Coin rewards</GoldPill>
              <h2 className="mt-3 font-display text-2xl font-bold text-slate-900 sm:text-3xl">
                Online raho, coins kamao
              </h2>
              <p className="mt-2 text-sm text-slate-600 sm:text-base">
                AutoClip app jitni der phone pe online rahegi, utne coins milenge:
              </p>
              <ul className="mt-4 grid gap-3">
                {[
                  ["10 min online", "100 coins"],
                  ["2 ghante online", "1,000 coins"],
                  ["4 ghante online", "3,000 coins"],
                ].map(([time, coins]) => (
                  <li
                    key={time}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
                  >
                    <span className="text-sm font-semibold text-slate-700">{time}</span>
                    <span className="font-display text-lg font-extrabold text-amber-600">{coins}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Imaandaar note
              </p>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                Coins <strong>sirf reward points hain</strong> — inki{" "}
                <strong>koi cash value nahi</strong> hai aur inhe paise me nahi badla ja sakta.
                Future me token listing ka plan hai (Hamster Kombat/Dogs jaisa), lekin ye{" "}
                <strong>abhi sirf ek plan hai — koi promise nahi.</strong>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= FAQ ================= */}
      <section className="mx-auto max-w-3xl px-4 pb-14 sm:px-6">
        <h2 className="text-center font-display text-2xl font-bold text-slate-900 sm:text-3xl">
          Aam sawal
        </h2>
        <div className="mt-8 grid gap-3">
          {faqs.map((f) => (
            <details
              key={f.q}
              className="group rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold text-slate-900">
                {f.q}
                <span className="shrink-0 text-emerald-600 transition-transform group-open:rotate-45">
                  <Icon d="M12 5v14M5 12h14" />
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ================= FINAL CTA ================= */}
      <section className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6">
          <img
            src="/brand-cf.webp"
            alt="ClipFlow CF logo"
            className="mx-auto h-16 w-16 rounded-2xl bg-white object-contain shadow-sm ring-1 ring-slate-200"
          />
          <h2 className="mt-4 font-display text-2xl font-bold text-slate-900 sm:text-3xl">
            Aaj hi apna clipping setup karo
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600 sm:text-base">
            Account banao, app install karo, pehla campaign schedule karo — 10 minute me sab ready.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="w-full rounded-xl bg-emerald-600 px-7 py-3.5 text-base font-bold text-white shadow-md transition-all hover:bg-emerald-700 active:scale-95 sm:w-auto"
            >
              Free me shuru karo
            </Link>
            <Link
              href="/guide"
              className="w-full rounded-xl border border-slate-300 bg-white px-7 py-3.5 text-base font-bold text-slate-800 shadow-sm transition-all hover:border-emerald-400 hover:text-emerald-700 active:scale-95 sm:w-auto"
            >
              Pehle guide padho
            </Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
