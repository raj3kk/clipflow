import { getDashboard } from "@/lib/state";
import StatusPill from "@/lib/status-pill";

export const dynamic = "force-dynamic";

export default async function Runs() {
  const d = await getDashboard();
  const runs = d?.runs ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Pipeline runs</h1>
      <p className="text-slate-400 text-sm mb-6">
        Har autopilot run ka step-by-step log — kya hua, kab hua.
      </p>

      {runs.length === 0 && (
        <p className="text-slate-500 text-sm">Abhi tak koi run nahi hua.</p>
      )}

      <div className="space-y-4">
        {runs.map((r) => (
          <div
            key={r.id}
            className="rounded-xl border border-line bg-panel p-5"
          >
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <div className="font-semibold text-sm">{r.id}</div>
                <div className="text-xs text-slate-500">
                  {r.started_at.replace("T", " ").slice(0, 16)}
                </div>
              </div>
              <StatusPill status={r.status} />
            </div>
            <ol className="text-sm text-slate-300 space-y-1.5">
              {r.steps.map((s, i) => (
                <li key={i}>
                  <span className="text-slate-500 font-mono text-xs mr-2">
                    {s.t}
                  </span>
                  {s.msg}
                </li>
              ))}
            </ol>
            {r.error && (
              <p className="text-red-300 text-sm mt-3">Error: {r.error}</p>
            )}
            <div className="flex gap-4 mt-3 text-sm">
              {r.reel_url && (
                <a
                  href={r.reel_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  Reel
                </a>
              )}
              {r.whop_status && (
                <span className="text-slate-400">
                  Whop:{" "}
                  <span className="text-slate-200">{r.whop_status}</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
