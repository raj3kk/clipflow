"use client";

import { useEffect, useState } from "react";
import { Campaign } from "@/lib/types";

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((d) => setCampaigns(d.campaigns ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-slate-400">Loading campaigns…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Campaigns</h1>
      <p className="text-slate-400 text-sm mb-6">
        {campaigns.length} active campaigns · sorted by payout
      </p>
      <div className="grid gap-4">
        {campaigns.map((c) => (
          <div key={c.id} className="rounded-xl border border-line bg-panel p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold text-lg">{c.name}</h2>
                <p className="text-sm text-slate-400">{c.sponsor}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-2xl font-bold text-accent">
                  ${c.payout_per_1k_usd.toFixed(2)}
                  <span className="text-sm font-normal text-slate-400">/1k views</span>
                </div>
                {c.budget_remaining_usd != null && (
                  <div className="text-xs text-slate-400">
                    ${c.budget_remaining_usd.toLocaleString()} budget left
                  </div>
                )}
              </div>
            </div>
            <p className="text-sm text-slate-300 mt-3 whitespace-pre-wrap">{c.requirements}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-line px-2 py-1">{c.min_seconds}–{c.max_seconds}s</span>
              {c.hashtags.map((h) => (
                <span key={h} className="rounded bg-line px-2 py-1 text-accent">{h}</span>
              ))}
              {c.joined && (
                <span className="rounded bg-emerald-900 px-2 py-1 text-emerald-300">joined</span>
              )}
            </div>
            {c.brief_url && (
              <a href={c.brief_url} target="_blank" rel="noreferrer" className="text-xs text-accent underline mt-3 inline-block">
                Open brief ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
