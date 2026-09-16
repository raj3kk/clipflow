"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import { cardCls, fmtDT, inputCls } from "../components/ui";
import { ActivityEntry } from "@/lib/types";

interface Resp {
  entries: ActivityEntry[];
  configured: boolean;
  error?: string;
}

function renderDetail(detail: unknown): string {
  if (detail == null) return "—";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return "—";
  }
}

export default function ActivityPage() {
  const { data, loading, error, reload } = useApi<Resp>("/api/activity?limit=100");
  const [filter, setFilter] = useState("");

  // Auto-refresh every 30s.
  useEffect(() => {
    const t = setInterval(() => reload(), 30000);
    return () => clearInterval(t);
  }, [reload]);

  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const f = filter.trim().toLowerCase();
    if (!f) return all;
    return all.filter((e) =>
      [e.actor, e.event, e.detail ?? ""].join(" ").toLowerCase().includes(f)
    );
  }, [data, filter]);

  if (loading) return <p className="text-slate-400">Loading activity…</p>;
  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Activity</h1>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          API error: {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Activity</h1>
        <button
          onClick={reload}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-slate-300 hover:bg-line"
        >
          ↻ Refresh
        </button>
      </div>
      <p className="text-slate-400 text-sm mb-6">
        Append-only event log — auto-refreshes every 30s.
      </p>

      {data && !data.configured && <SetupBanner />}

      <div className="mb-4 max-w-md">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by actor, event, or detail…"
          className={inputCls + " !mt-0"}
        />
      </div>

      <div className={`${cardCls} overflow-x-auto`}>
        {entries.length === 0 ? (
          <p className="text-sm text-slate-500">
            {filter ? "No entries match the filter." : "No activity yet."}
          </p>
        ) : (
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-line">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Actor</th>
                <th className="py-2 pr-3">Event</th>
                <th className="py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3 text-xs text-slate-400 whitespace-nowrap">
                    {fmtDT(e.ts)}
                  </td>
                  <td className="py-2 pr-3 text-slate-300">{e.actor}</td>
                  <td className="py-2 pr-3 text-accent">{e.event}</td>
                  <td className="py-2 text-slate-400 text-xs max-w-md break-words">
                    {renderDetail(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
