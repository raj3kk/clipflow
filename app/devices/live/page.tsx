"use client";

import { useEffect, useState } from "react";
import { useApi } from "../../components/useApi";

interface LiveDevice {
  id: string;
  device_name: string;
  platform: string;
  app_version: string;
  status: string;
  paused_until: string | null;
  last_seen: string | null;
  presence: "online" | "idle" | "offline";
}

interface ActiveJob {
  id: string;
  device_id: string;
  device_name: string;
  type: string;
  status: string;
  attempts: number;
  created_at: string;
  last_heartbeat: string | null;
}

interface RecentRun {
  id: string;
  job_id: string;
  device_id: string;
  device_name: string;
  status: string;
  finished_at: string;
  note: string;
}

interface LiveResp {
  devices: LiveDevice[];
  active: ActiveJob[];
  recent: RecentRun[];
}

const cardCls =
  "rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-4 shadow-[0_8px_32px_rgba(0,0,0,0.35)]";

function timeAgo(iso: string | null): string {
  if (!iso) return "kabhi nahi";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s pehle`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m pehle`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h pehle`;
  return `${Math.floor(h / 24)}d pehle`;
}

function elapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-sky-400/15 text-sky-300 border-sky-400/30",
  claimed: "bg-amber-400/15 text-amber-300 border-amber-400/30",
  running: "bg-violet-400/15 text-violet-300 border-violet-400/30",
  succeeded: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
  failed: "bg-rose-400/15 text-rose-300 border-rose-400/30",
  blocked: "bg-orange-400/15 text-orange-300 border-orange-400/30",
};

function Pill({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] ?? "bg-slate-400/15 text-slate-300 border-slate-400/30";
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

const PRESENCE_DOT: Record<string, string> = {
  online: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]",
  idle: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]",
  offline: "bg-slate-600",
};

const PRESENCE_LABEL: Record<string, string> = {
  online: "online",
  idle: "idle",
  offline: "offline",
};

export default function LivePage() {
  const { data, loading, error, reload } = useApi<LiveResp>("/api/devices/live");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);

  // har 10s me auto-refresh — live nazar
  useEffect(() => {
    const t = setInterval(() => reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold magic-text">Live</h1>
          <p className="text-sm text-slate-400">
            Abhi kya ho raha hai — automation ek nazar me
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
          </span>
          {updatedAt ? `updated ${timeAgo(updatedAt.toISOString())}` : "…"}
        </div>
      </div>

      {loading && !data && (
        <p className="text-slate-400 text-sm">Live status la rahe hain…</p>
      )}
      {error && (
        <div className={`${cardCls} border-rose-400/30`}>
          <p className="text-rose-300 text-sm">{error}</p>
          <button
            onClick={reload}
            className="mt-2 text-xs underline underline-offset-2 text-slate-300"
          >
            Dobara try karo
          </button>
        </div>
      )}

      {data && (
        <>
          {/* abhi chal raha hai */}
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-2">
              Abhi chal raha hai
            </h2>
            {data.active.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-400">
                  Abhi koi automation nahi chal rahi. Devices tab se{" "}
                  <span className="text-slate-200 font-medium">▶ Run Now</span>{" "}
                  dabao ya schedule ka wait karo.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.active.map((j) => (
                  <div key={j.id} className={cardCls}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-sm">{j.device_name}</div>
                      <Pill status={j.status} />
                    </div>
                    <div className="mt-2 text-xs text-slate-400 space-y-1">
                      <div>
                        Kaam: <span className="text-slate-200">{j.type}</span>
                      </div>
                      <div>
                        Shuru hue:{" "}
                        <span className="text-slate-200 font-mono">
                          {elapsed(j.created_at)}
                        </span>{" "}
                        pehle
                      </div>
                      {j.last_heartbeat && (
                        <div>
                          Phone ka signal:{" "}
                          <span className="text-slate-200">
                            {timeAgo(j.last_heartbeat)}
                          </span>
                        </div>
                      )}
                      {j.attempts > 0 && (
                        <div>
                          Koshish: <span className="text-slate-200">{j.attempts}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* devices */}
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-2">Devices</h2>
            {data.devices.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-400">
                  Koi device linked nahi. Devices tab me enroll karo.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.devices.map((d) => (
                  <div key={d.id} className={cardCls}>
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${PRESENCE_DOT[d.presence]}`}
                      />
                      <div className="font-semibold text-sm">{d.device_name}</div>
                      <span className="text-[11px] text-slate-500">
                        {PRESENCE_LABEL[d.presence]}
                      </span>
                      {d.status === "paused" && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full border bg-orange-400/15 text-orange-300 border-orange-400/30">
                          paused
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-slate-400 space-y-1">
                      <div>
                        Code:{" "}
                        <span className="font-mono font-bold tracking-[0.2em] magic-text">
                          {d.id.slice(0, 8).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        Last seen:{" "}
                        <span className="text-slate-200">{timeAgo(d.last_seen)}</span>
                      </div>
                      <div>
                        {d.platform} · v{d.app_version}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* pichhle 24 ghante */}
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-2">
              Pichhle 24 ghante
            </h2>
            {data.recent.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-400">
                  Pichhle 24 ghante me koi run nahi hui.
                </p>
              </div>
            ) : (
              <div className={`${cardCls} divide-y divide-white/5`}>
                {data.recent.map((r) => (
                  <div
                    key={r.id}
                    className="py-2.5 flex items-start justify-between gap-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200 truncate">
                        {r.device_name}
                      </div>
                      {r.note && (
                        <div className="text-xs text-slate-500 truncate">
                          {r.note}
                        </div>
                      )}
                      <div className="text-[11px] text-slate-600">
                        {timeAgo(r.finished_at)}
                      </div>
                    </div>
                    <Pill status={r.status} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
