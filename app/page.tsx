"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DayStats } from "@/lib/types";
import { DAILY_TARGET } from "@/lib/seed";

export default function Dashboard() {
  const [stats, setStats] = useState<DayStats | null>(null);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        setStats(d.stats);
        setConfigured(d.configured !== false);
      })
      .catch(() => {});
  }, []);

  const s = stats ?? {
    date: new Date().toISOString().slice(0, 10),
    target: DAILY_TARGET,
    submitted: 0,
    posted: 0,
    in_pipeline: 0,
    est_earnings_usd: 0,
  };
  const pct = Math.min(100, Math.round((s.submitted / s.target) * 100));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
      <p className="text-slate-400 text-sm mb-6">
        Aaj ka progress — {s.date} · target {s.target}/day
      </p>

      {!configured && (
        <div className="mb-6 rounded-xl border border-gold/40 bg-gold/10 p-4 text-sm">
          <span className="font-semibold text-gold">Setup pending:</span> Supabase
          connect nahi hai. Live data ke liye Supabase project banao aur env vars
          set karo (README dekho).
        </div>
      )}

      <div className="mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span>Submissions: {s.submitted}/{s.target}</span>
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
        {[
          { label: "Submitted", value: s.submitted },
          { label: "Posted", value: s.posted },
          { label: "In pipeline", value: s.in_pipeline },
          { label: "Est. earnings", value: `$${s.est_earnings_usd.toFixed(2)}` },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-line bg-panel p-5">
            <div className="text-3xl font-bold text-accent">{c.value}</div>
            <div className="text-sm text-slate-400 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-panel p-5">
        <h2 className="font-semibold mb-3">Pipeline — kaise kaam karta hai</h2>
        <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
          <li>Campaigns page se campaign chuno (rate + budget + requirements).</li>
          <li>Clips page se naya render job banao — server pe video render hoga.</li>
          <li>Preview dekho, sahi lage to Approve karo.</li>
          <li>Post dabao — Instagram pe Reel jayega (connection ke baad).</li>
          <li>Whop pe submit karo — 20 minute ke andar, automatic.</li>
        </ol>
        <div className="mt-4 flex gap-3">
          <Link href="/campaigns" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink">Campaigns</Link>
          <Link href="/clips" className="rounded-lg border border-line px-4 py-2 text-sm">Clips</Link>
        </div>
      </div>
    </div>
  );
}
