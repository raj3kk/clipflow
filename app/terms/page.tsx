import { PublicHeader, PublicFooter } from "../components/PublicSite";

export const metadata = {
  title: "Terms of Service",
  description:
    "ClipFlow ke Terms of Service: service aapke phone se clipping automate karti hai; Instagram/Whop ke niyam aapki zimmedari; coins ki koi cash value nahi; service jaisi-hai basis par.",
  openGraph: {
    title: "ClipFlow — Terms of Service",
    description:
      "Service aapke phone se clipping automate karti hai. Coins sirf reward points — koi cash value nahi. Refund ka sawal nahi, kyunki koi payment hai hi nahi.",
    url: "https://clipflow-webbuilder1.vercel.app/terms",
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

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: 19 September 2026</p>

        <div className="mt-8 grid gap-4">
          <Section t="1. Service kya hai">
            <p>
              ClipFlow ek website + AutoClip Android app hai jo <strong>aapke apne phone se
              clipping automate karti hai</strong>: aap campaign chunte hain, schedule lagate
              hain, aur app aapke Instagram account se reel post karke link submit karti hai.
            </p>
            <p>
              Service <strong>bilkul free</strong> hai. Koi payment, subscription ya hidden charge
              nahi hai.
            </p>
          </Section>

          <Section t="2. Instagram aur Whop ke niyam — aapki zimmedari">
            <p>
              App <strong>aapke apne</strong> Instagram aur Whop account use karti hai. Instagram
              aur Whop ke community guidelines / terms follow karna <strong>aapki zimmedari</strong> hai.
            </p>
            <p>
              Agar automation ke kaaran aapke account pe koi action hota hai (warning, limit,
              block ya ban), to uski <strong>zimmedari ClipFlow ki nahi hogi</strong>. Hum aapko
              safe settings (jaise din me max 4 runs) dene ki koshish karte hain, lekin final risk
              aapka hai.
            </p>
          </Section>

          <Section t="3. Coins — sirf reward points">
            <p>
              Coins sirf <strong>reward points</strong> hain. Unki <strong>koi cash value nahi</strong> hai:
              inhe paise me nahi badla ja sakta, transfer nahi kiya ja sakta, aur inka koi monetary
              vaada nahi hai.
            </p>
            <p>
              Future me token listing ka plan hai (Hamster Kombat/Dogs jaisa), lekin ye{" "}
              <strong>sirf ek plan hai — koi guarantee ya promise nahi</strong>. Coins ka balance
              kabhi bhi galti se credit/debit ho sakta hai aur sudhara ja sakta hai.
            </p>
          </Section>

          <Section t="4. Service &quot;jaisi hai&quot; (as-is)">
            <p>
              Service <strong>&quot;jaisi hai&quot;</strong> di jaati hai. Agar aapka phone off ho jaye,
              internet chala jaye, battery khatam ho jaye, ya app OS ke kaaran band ho jaye —
              to posting <strong>ruk sakti hai ya fail ho sakti hai</strong>. Hum har post ke
              successful hone ki guarantee nahi dete.
            </p>
            <p>
              Android version, phone brand aur OS settings ke hisaab se behavior alag ho sakta hai.
            </p>
          </Section>

          <Section t="5. Refund">
            <p>
              Koi payment hai hi nahi — isliye <strong>refund ka sawal hi nahi uthta</strong>.
            </p>
          </Section>

          <Section t="6. Fair use">
            <p>
              Service ka use sirf sahi maksad ke liye karein: spam, fake engagement, copyright
              content ka bina permission use, ya kisi bhi galat kaam ke liye service ka use
              <strong> mana hai</strong>. Aise cases me account band kiya ja sakta hai.
            </p>
          </Section>

          <Section t="7. Changes">
            <p>
              Ye terms kabhi bhi update ho sakte hain. Bade changes ki khabar website pe di jayegi.
              Service ka use jaari rakhna matlab naye terms se sehmati.
            </p>
          </Section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
