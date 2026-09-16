"use client";

import { useEffect, useState } from "react";
import { Submission } from "@/lib/types";

export default function SubmissionsPage() {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/submissions")
      .then((r) => r.json())
      .then((d) => setSubs(d.submissions ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-slate-400">Loading submissions…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Submissions</h1>
      <p className="text-slate-400 text-sm mb-6">Whop ko bheje gaye clips</p>
      {subs.length === 0 && (
        <p className="text-slate-500 text-sm">Abhi koi submission nahi hai.</p>
      )}
      <div className="grid gap-4">
        {subs.map((s) => (
          <div key={s.id} className="rounded-xl border border-line bg-panel p-5 flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold text-sm">{s.campaign_name ?? s.clip_id}</div>
              <a href={s.instagram_url} target="_blank" rel="noreferrer" className="text-xs text-accent underline break-all">
                {s.instagram_url}
              </a>
              <div className="text-xs text-slate-400 mt-1">
                {s.submitted_at ? new Date(s.submitted_at).toLocaleString("en-IN") : "—"}
                {s.views != null && <> · {s.views.toLocaleString()} views</>}
                {s.earnings_usd != null && <> · ${s.earnings_usd.toFixed(2)}</>}
              </div>
            </div>
            <span className="rounded bg-emerald-900 px-2 py-1 text-xs text-emerald-200 shrink-0">
              {s.whop_status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
