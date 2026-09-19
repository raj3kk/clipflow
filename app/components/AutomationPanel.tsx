"use client";

import { useCallback, useEffect, useState } from "react";
import { cardCls, fmtDT } from "./ui";

interface Run {
  id: string;
  trigger: string;
  status: string;
  current_step: string | null;
  detail: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface RunsResp {
  runs: Run[];
  active: Run | null;
  queue_position: number;
  used_24h: number;
  cap: number;
  resets_at: string | null;
  configured: boolean;
  error?: string;
}

const STEP_LABELS: Record<string, string> = {
  queued: "Queue me",
  running: "Chal raha hai",
  done: "Poora hua",
  failed: "Fail hua",
  skipped: "Skip hua",
  cancelled: "Cancel hua",
};

const DOT: Record<string, string> = {
  queued: "bg-yellow-400",
  running: "bg-green-400 animate-pulse",
  done: "bg-slate-500",
  failed: "bg-red-400",
  skipped: "bg-slate-500",
  cancelled: "bg-slate-500",
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "abhi";
  if (m < 60) return `${m} min pehle`;
  const h = Math.floor(m / 60);
  return `${h} ghante ${m % 60} min pehle`;
}

function dur(r: Run): string {
  const a = r.started_at ?? r.created_at;
  const b = r.finished_at ?? new Date().toISOString();
  const m = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
  return m < 1 ? "<1 min" : `${m} min`;
}

export default function AutomationPanel() {
  const [data, setData] = useState<RunsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/automation/runs", { cache: "no-store" });
      const d = (await r.json()) as RunsResp;
      if (!r.ok) setErr(d.error ?? `Request failed (${r.status})`);
      else {
        setData(d);
        setErr(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/automation/run", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setMsg(d.error ?? `Fail (${r.status})`);
      } else {
        setMsg(
          d.queue_position > 1
            ? `Run queue me hai — position #${d.queue_position}, lagbhag ${d.eta_minutes} min me shuru hoga.`
            : "Run queue me hai — worker kuch hi minute me pick karega."
        );
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
      load(true);
    }
  };

  if (loading && !data) return null;
  if (err && !data) return null;
  if (!data) return null;

  const active = data.active;
  const capHit = data.used_24h >= data.cap;
  const btnDisabled = busy || capHit || !!active;
  const btnLabel = busy
    ? "Start ho raha hai…"
    : capHit
      ? `Limit poori (${data.used_24h}/${data.cap})`
      : active
        ? active.status === "running"
          ? "Ek run chal raha hai…"
          : "Ek run queue me hai…"
        : "▶ Run automation now";

  return (
    <div className={`${cardCls} mb-8`}>
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">Automation — background me kya chal raha hai</h2>
        <span className="text-xs text-slate-500">
          {data.used_24h}/{data.cap} runs · pichhle 24 ghante
        </span>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Jab chaaho khud automation chalao — worker pick karke pura cycle karega
        (campaign → clip → post → verify → Whop submit). Max {data.cap} runs / 24 ghante.
      </p>

      {active ? (
        <div className="rounded-lg border border-line bg-slate-100 p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[active.status] ?? "bg-slate-500"}`} />
            <span className="font-medium text-sm">
              {STEP_LABELS[active.status] ?? active.status}
              {active.trigger === "manual" ? " · tumne start kiya" : " · scheduled"}
            </span>
            <span className="text-xs text-slate-500 ml-auto">
              {active.status === "running" ? `shuru ${ago(active.started_at)}` : `queued ${ago(active.created_at)}`}
            </span>
          </div>
          {active.current_step && (
            <p className="text-sm text-slate-700 mt-1">{active.current_step}</p>
          )}
          {active.status === "queued" && data.queue_position > 0 && (
            <p className="text-xs text-slate-500 mt-1">
              Queue position #{data.queue_position} — lagbhag {data.queue_position * 45} min me shuru hoga.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mb-4">Abhi background me kuch nahi chal raha — idle hai.</p>
      )}

      <button
        onClick={runNow}
        disabled={btnDisabled}
        className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition ${
          btnDisabled
            ? "bg-slate-700/50 text-slate-600 cursor-not-allowed"
            : "bg-accent text-white hover:opacity-90"
        }`}
      >
        {btnLabel}
      </button>
      {capHit && data.resets_at && (
        <p className="text-xs text-amber-700 mt-2">
          Limit {fmtDT(data.resets_at)} ke baad reset hogi.
        </p>
      )}
      {msg && <p className="text-xs text-slate-700 mt-2">{msg}</p>}

      {data.runs.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-slate-600 mb-2">Recent runs</h3>
          <div className="space-y-1.5">
            {data.runs.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs border-b border-line pb-1.5 last:border-0">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[r.status] ?? "bg-slate-500"}`} />
                <span className="text-slate-700 w-20 shrink-0">{STEP_LABELS[r.status] ?? r.status}</span>
                <span className="text-slate-500 truncate flex-1">
                  {r.status === "failed" && r.error
                    ? r.error
                    : r.current_step ?? (r.trigger === "manual" ? "manual run" : "scheduled run")}
                </span>
                <span className="text-slate-500 shrink-0">{dur(r)}</span>
                <span className="text-slate-600 shrink-0">{ago(r.finished_at ?? r.started_at ?? r.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
