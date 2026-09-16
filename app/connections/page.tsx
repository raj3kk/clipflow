import { getDashboard, statusPill } from "@/lib/state";

export const dynamic = "force-dynamic";

export default async function Connections() {
  const d = await getDashboard();
  const ig = d?.connections.instagram;
  const whop = d?.connections.whop;

  const card = (
    title: string,
    c?: { account: string; status: string; last_verified: string; note: string }
  ) => (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold">{title}</h2>
        {c && statusPill(c.status)}
      </div>
      {c ? (
        <>
          <div className="text-sm text-slate-300">{c.account}</div>
          <div className="text-xs text-slate-500 mt-1">
            Last verified: {c.last_verified.replace("T", " ").slice(0, 16)}
          </div>
          <p className="text-sm text-slate-400 mt-3">{c.note}</p>
        </>
      ) : (
        <p className="text-sm text-slate-500">No data yet.</p>
      )}
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Connections</h1>
      <p className="text-slate-400 text-sm mb-6">
        Instagram + Whop login health — autopilot har run me verify karta hai.
      </p>

      <div className="grid md:grid-cols-2 gap-4 mb-8">
        {card("Instagram", ig)}
        {card("Whop", whop)}
      </div>

      <div className="rounded-xl border border-line bg-panel p-5 mb-6">
        <h2 className="font-semibold mb-3">Login kaise kaam karta hai</h2>
        <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
          <li>
            Passwords website ke database me <b>save nahi hote</b> — wo secure
            vault me rehte hain, sirf automation browser use karta hai.
          </li>
          <li>
            Har autopilot run se pehle dono sessions check hote hain. Agar
            session toot jaye to run ruk jata hai aur owner ko notify hota hai —
            adhoora kaam nahi hota.
          </li>
          <li>
            Google ka 2-step verification hataya ja raha hai, taaki phone tap ke
            bina sign-in ho sake.
          </li>
        </ol>
      </div>

      {d && d.guards.length > 0 && (
        <div className="rounded-xl border border-line bg-panel p-5">
          <h2 className="font-semibold mb-3">
            Safety guards — galtiyon se seekha hua
          </h2>
          <ul className="text-sm text-slate-300 space-y-2 list-disc list-inside">
            {d.guards.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
