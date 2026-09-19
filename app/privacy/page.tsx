import { PublicHeader, PublicFooter } from "../components/PublicSite";

export const metadata = {
  title: "Privacy Policy",
  description:
    "ClipFlow Privacy Policy: kya store hota hai (email, device info, encrypted tokens), kya kabhi store nahi hota (aapke Instagram/Whop passwords), data kabhi becha nahi jata, delete par 7 din me safai.",
  openGraph: {
    title: "ClipFlow — Privacy Policy",
    description:
      "Aapke Instagram/Whop passwords hum chhoote bhi nahi. Data kabhi becha ya teesre ko diya nahi jata. Delete par 7 din me saaf.",
    url: "https://clipflow-webbuilder1.vercel.app/privacy",
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

function Section({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="font-display text-lg font-bold text-slate-900">{t}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: 19 September 2026</p>

        <div className="mt-8 grid gap-4">
          <Section t="1. Hum kya store karte hain">
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Email</strong> — aapke account ke liye.</li>
              <li><strong>Device info</strong> — device code, model, app version, online/offline status.</li>
              <li><strong>Login tokens (encrypted)</strong> — Instagram/Whop session tokens, encrypted form me, taaki app dobara login na mange.</li>
              <li><strong>Activity data</strong> — kaunse post kab hue, coins ka hisaab.</li>
            </ul>
          </Section>

          <Section t="2. Hum kya KABHI store nahi karte">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="font-semibold text-emerald-900">
                Aapke Instagram aur Whop ke <strong>passwords hum chhoote bhi nahi</strong>.
              </p>
              <p className="mt-1 text-emerald-800">
                Login aapke phone pe, aapke haath se hota hai. Password humare server tak kabhi
                pahunchta hi nahi — sirf encrypted session token save hota hai.
              </p>
            </div>
          </Section>

          <Section t="3. Data ka use">
            <p>
              Aapka data <strong>sirf service chalane ke liye</strong> use hota hai: phone connect
              karna, posting karna, coins ka hisaab, aur problem aane par madad karna.
            </p>
            <p>
              Aapka data <strong>kabhi becha nahi jata</strong> aur <strong>kisi teesre ko diya nahi
              jata</strong> — na advertisement ke liye, na kisi aur kaam ke liye.
            </p>
          </Section>

          <Section t="4. Data delete karna">
            <p>
              Aap kabhi bhi apna <strong>device ya account delete</strong> kar sakte hain. Delete
              ke baad aapka saara data <strong>7 din ke andar poori tarah saaf</strong> kar diya jata hai.
            </p>
          </Section>

          <Section t="5. Security">
            <p>
              Tokens encrypted store hote hain aur connection HTTPS se hota hai. Phir bhi, koi bhi
              internet service 100% safe nahi hoti — hum best practices follow karte hain, lekin
              poorn guarantee nahi de sakte.
            </p>
          </Section>

          <Section t="6. Contact">
            <p>
              Privacy se juda koi sawal ho to website me AI agent ke chat button se poochhein —
              woh aapko sahi jagah pahunchayega.
            </p>
          </Section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
