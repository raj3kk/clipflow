import Link from "next/link";
import { getDashboard, statusPill } from "@/lib/state";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const d = await getDashboard();

  if (!d) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
        <p className="text-slate-400 text-sm">
          State file nahi mil rahi (state/dashboard.json). Autopilot ke pehle run
          ke baad yahan live data aayega.
        </p>
      </div>
    );
  }

  const t = d.today;
  const pct = Math.min(100, Math.round((t.submitted / t.target) * 100));
  const pending = d.submissions.filter((s) => s.status === "pending").length;
  const latest = d.runs[0];

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold">Autopilot Dashboard</h1>
        <span className="text-xs text-slate-500">
          updated {d.updated_at.replace("T", " ").slice(0, 16)}
        </span>
      </div>
      <p className="text-slate-400 text-sm mb-6">
        Aaj ka progress — {t.date} · target {t.target}/day · fully automated
        pipeline
      </p>

      <div className="mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span>
            Submissions: {t.submitted}/{t.target}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-3 rounded-full bg-line overflow-hidden">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="text-sm text-slate-400 mb-2">Instagram</div>
          {statusPill(d.connections.instagram.status)}
          <div className="text-xs text-slate-500 mt-2">
            {d.connections.instagram.account}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="text-sm text-slate-400 mb-2">Whop</div>
          {statusPill(d.connections.whop.status)}
          <div className="text-xs text-slate-500 mt-2">
            {d.connections.whop.account}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="text-3xl font-bold text-accent">{pending}</div>
          <div className="text-sm text-slate-400 mt-1">Pending review</div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="text-3xl font-bold text-accent">{d.guards.length}</div>
          <div className="text-sm text-slate-400 mt-1">Safety guards active</div>
        </div>
      </div>

      {latest && (
        <div className="rounded-xl border border-line bg-panel p-5 mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Latest run — {latest.id}</h2>
            {statusPill(latest.status)}
          </div>
          <ol className="text-sm text-slate-300 space-y-1.5">
            {latest.steps.map((s, i) => (
              <li key={i}>
                <span className="text-slate-500 font-mono text-xs mr-2">
                  {s.t}
                </span>
                {s.msg}
              </li>
            ))}
          </ol>
          {latest.reel_url && (
            <a
              href={latest.reel_url}
              target="_blank"
              rel="noreferrer"
              className="text-accent text-sm underline mt-3 inline-block"
            >
              View reel
            </a>
          )}
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel p-5 mb-8">
        <h2 className="font-semibold mb-3">Campaigns</h2>
        <div className="space-y-3">
          {d.campaigns.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0"
            >
              <div>
                <div className="font-medium text-sm">{c.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  ${c.payout_per_1k_usd.toFixed(2)}/1K views
                  {c.budget_remaining_usd != null &&
                    ` · $${c.budget_remaining_usd.toLocaleString()} left`}
                </div>
              </div>
              <div className="flex gap-1 flex-wrap justify-end">
                {c.hashtags.map((h) => (
                  <span key={h} className="text-xs text-accent">
                    {h}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel p-5">
        <h2 className="font-semibold mb-3">Pipeline — kaise kaam karta hai</h2>
        <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
          <li>Autopilot har 6 ghante me chalta hai (din me 4 clips tak).</li>
          <li>Campaign chunta hai — rate × bacha hua budget × fit.</li>
          <li>9:16 clip render karta hai, Instagram pe Reel post karta hai.</li>
          <li>Live Reel verify karke <b>20 minute ke andar</b> Whop pe submit.</li>
          <li>Sab kuch yahan dashboard pe dikhta hai — runs, submissions, health.</li>
        </ol>
        <div className="mt-4 flex gap-3">
          <Link
            href="/runs"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink"
          >
            View runs
          </Link>
          <Link
            href="/connections"
            className="rounded-lg border border-line px-4 py-2 text-sm"
          >
            Connections
          </Link>
        </div>
      </div>
    </div>
  );
}
