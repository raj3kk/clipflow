import Link from "next/link";
import { PublicHeader, PublicFooter } from "../components/PublicSite";

export const metadata = {
  title: "Setup Guide — AutoClip App Kaise Chalaye",
  description:
    "AutoClip app setup ka step-by-step Hinglish guide: APK install, account, 8-char device code, Instagram + Whop login, schedule ya Run Now, coins kamao.",
  openGraph: {
    title: "ClipFlow Setup Guide — AutoClip App Kaise Chalaye",
    description:
      "7 simple steps: APK install karo, account banao, device code link karo, Instagram + Whop login karo, schedule lagao ya Run Now dabao, coins kamao.",
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

const steps = [
  {
    t: "AutoClip APK download aur install karo",
    d: "Apne Android phone pe AutoClip app ka APK download karo aur install karo. (Phone pe \"unknown sources\" se install ki permission mang sakta hai — woh allow kar dena.) App kholo aur aage badho.",
    tag: "Phone pe",
  },
  {
    t: "Website pe account banao",
    d: "ClipFlow website pe jao aur Signup pe click karke apna account banao (email + password). Account banne ke baad Login karo — aapko Devices page dikhega.",
    tag: "Website pe",
  },
  {
    t: "8-char device code link karo",
    d: "Website ke Devices page pe aapka 8-char device code dikhega (jaise A1B2C3D4). App me ye code dalo — isse aapka phone website se connect ho jayega.",
    tag: "Dono pe",
  },
  {
    t: "App me Whop + Instagram login karo",
    d: "App ke andar apne Whop aur Instagram account se login karo. Ye login aapke apne account hain — hum aapke password kabhi store nahi karte.",
    tag: "App me",
  },
  {
    t: "Schedule lagao ya Run Now dabao",
    d: "Website pe clipping campaign chuno aur post ka time schedule karo. Jaldi hai? Run Now dabao — post turant start ho jayega. (Din me max 4 runs.)",
    tag: "Website pe",
  },
  {
    t: "Coins kamao",
    d: "Jab tak app online rahegi, coins milte rahenge: 10 min par 100 coins, 2 ghante par 1000 coins, 4 ghante par 3000 coins. Yaad rahe: coins sirf reward points hain, inki koi cash value nahi.",
    tag: "Auto",
  },
  {
    t: "Dikkat ho? AI agent se poocho",
    d: "Kahi atak jao to website me AI agent ka chat button dabao — woh step-by-step help karega. Device offline dikhe to pehle phone ka internet aur battery saver check karo.",
    tag: "Madad",
  },
];

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Setup Guide
        </h1>
        <p className="mt-2 text-sm text-slate-600 sm:text-base">
          AutoClip app ko 10 minute me chalana start karo — 7 simple steps, bilkul simple bhasha me.
        </p>

        <ol className="mt-8 grid gap-4">
          {steps.map((s, i) => (
            <li
              key={s.t}
              className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
            >
              <div className="flex items-start gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-600 to-emerald-500 font-display text-base font-extrabold text-white shadow-sm">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <span className="inline-block rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-700">
                    {s.tag}
                  </span>
                  <h2 className="mt-1.5 font-display text-lg font-bold text-slate-900">{s.t}</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.d}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:p-6">
          <h2 className="font-display text-base font-bold text-emerald-900">Ready ho?</h2>
          <p className="mt-1 text-sm text-emerald-800">
            Account abhi tak nahi banaya? Pehle signup karo, phir app install karo.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="rounded-xl bg-emerald-600 px-6 py-3 text-center text-sm font-bold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-95"
            >
              Free me shuru karo
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-emerald-300 bg-white px-6 py-3 text-center text-sm font-bold text-emerald-700 transition-all hover:bg-emerald-100 active:scale-95"
            >
              Login karo
            </Link>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
