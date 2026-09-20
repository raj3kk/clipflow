"use client";

import { useEffect, useState } from "react";
import { useApi } from "../../components/useApi";
import { cardCls } from "../../components/ui";

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
  heartbeat_count: number | null;
  current_step: string | null;
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

type CheckStatus = "done" | "active" | "pending" | "failed" | "active-unknown";

interface CheckStep {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  updated_at: string | null;
}

interface ActivityEvent {
  at: string;
  text: string;
  kind: string;
}

interface ChecklistResp {
  request: {
    id: string;
    status: string;
    stage: string | null;
    note: string;
    created_at: string;
    finished_at: string | null;
  } | null;
  job: {
    id: string;
    status: string;
    device_name: string;
    current_step: string | null;
    last_heartbeat: string | null;
    heartbeat_count: number | null;
  } | null;
  steps: CheckStep[];
  activity: ActivityEvent[];
}

const CHECK_TICKET: Record<CheckStatus, { tick: string; dot: string; ring: string }> = {
  done: { tick: "✓", dot: "bg-emerald-500", ring: "ring-emerald-200" },
  active: { tick: "▶", dot: "bg-blue-500", ring: "ring-blue-200" },
  pending: { tick: "○", dot: "bg-slate-300", ring: "ring-slate-200" },
  failed: { tick: "✗", dot: "bg-red-500", ring: "ring-red-200" },
  "active-unknown": { tick: "◐", dot: "bg-amber-400", ring: "ring-amber-200" },
};

const KIND_DOT: Record<string, string> = {
  start: "bg-blue-500",
  stage: "bg-indigo-400",
  job: "bg-amber-400",
  step: "bg-blue-400",
  upload: "bg-pink-400",
  verify: "bg-violet-400",
  submit: "bg-emerald-400",
  done: "bg-emerald-500",
  fail: "bg-red-500",
  retry: "bg-orange-400",
};

/** Automation checklist + live activity feed — har 10s auto-refresh. */
function AutomationChecklist() {
  const { data, loading, error, reload } = useApi<ChecklistResp>(
    "/api/automation/checklist"
  );

  useEffect(() => {
    const t = setInterval(() => reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-700 mb-2">
        Automation checklist
      </h2>
      <div className={cardCls}>
        {loading && !data && (
          <p className="text-slate-600 text-sm">Checklist la rahe hain…</p>
        )}
        {error && (
          <div>
            <p className="text-red-600 text-sm">{error}</p>
            <button
              onClick={reload}
              className="mt-2 text-xs underline underline-offset-2 text-slate-600 hover:text-slate-900"
            >
              Dobara try karo
            </button>
          </div>
        )}
        {data && data.steps.length === 0 && (
          <p className="text-sm text-slate-600">
            Abhi koi automation nahi chal rahi. Devices tab se{" "}
            <span className="text-slate-900 font-medium">▶ Run Now</span>{" "}
            dabao ya schedule ka wait karo.
          </p>
        )}
        {data && data.steps.length > 0 && (
          <>
            {/* request/job summary */}
            <div className="text-xs text-slate-500 mb-3">
              {data.request && (
                <span>
                  Request:{" "}
                  <span className="text-slate-800 font-medium">
                    {data.request.status}
                  </span>
                  {data.request.stage && ` · stage ${data.request.stage}`}
                </span>
              )}
              {data.request && data.job && <span> · </span>}
              {data.job && (
                <span>
                  Phone job:{" "}
                  <span className="text-slate-800 font-medium">
                    {data.job.status}
                  </span>{" "}
                  ({data.job.device_name})
                </span>
              )}
            </div>

            {/* vertical timeline */}
            <ol className="relative ml-3 border-l-2 border-slate-200 space-y-4">
              {data.steps.map((s) => {
                const t = CHECK_TICKET[s.status];
                return (
                  <li key={s.key} className="pl-5 relative">
                    <span
                      className={`absolute -left-[13px] top-0 h-6 w-6 rounded-full ${t.dot} ring-4 ${t.ring} flex items-center justify-center text-white text-[11px] font-bold`}
                    >
                      {t.tick}
                    </span>
                    <div className="text-sm font-semibold text-slate-900">
                      {s.label}
                      {s.status === "active-unknown" && (
                        <span className="ml-2 text-[11px] font-normal text-amber-700">
                          (pata nahi kaunsa step — map nahi hua)
                        </span>
                      )}
                    </div>
                    {s.detail && (
                      <div className="text-xs text-slate-600 mt-0.5 break-words">
                        {s.detail}
                      </div>
                    )}
                    {s.updated_at && (
                      <div className="text-[11px] text-slate-400">
                        {timeAgo(s.updated_at)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>

            {/* live activity feed */}
            {data.activity.length > 0 && (
              <div className="mt-5 pt-4 border-t border-slate-200">
                <h3 className="text-xs font-semibold text-slate-600 mb-2">
                  Abhi kya ho raha hai
                </h3>
                <ul className="space-y-2 max-h-64 overflow-y-auto">
                  {data.activity.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex items-start gap-2">
                      <span
                        className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${KIND_DOT[e.kind] ?? "bg-slate-400"}`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs text-slate-800 leading-snug">
                          {e.text}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {timeAgo(e.at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

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

/** heartbeat kitne min purana hai (null = kabhi khabar nahi aayi) */
function hbAgeMin(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
}

// 10+ min se heartbeat band = phone se jawab nahi (sirf heartbeat-capable
// app pe — heartbeat_count>0 matlab app heartbeat bhejta hai). Server ka
// watchdog (pipeline_watch, har 1 min) aise job ko khud wapas queue karta hai.

// Light theme status pills (white premium, emerald accent).
const STATUS_STYLE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-700 border-slate-300",
  claimed: "bg-amber-50 text-amber-700 border-amber-300",
  running: "bg-blue-50 text-blue-700 border-blue-300",
  succeeded: "bg-emerald-50 text-emerald-700 border-emerald-300",
  failed: "bg-red-50 text-red-700 border-red-300",
  blocked: "bg-orange-50 text-orange-700 border-orange-300",
};

function Pill({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] ?? "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

const PRESENCE_DOT: Record<string, string> = {
  online: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]",
  idle: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]",
  offline: "bg-slate-400",
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
          <h1 className="text-2xl font-bold text-emerald-700">Live</h1>
          <p className="text-sm text-slate-600">
            Abhi kya ho raha hai — automation ek nazar me
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
          </span>
          {updatedAt ? `updated ${timeAgo(updatedAt.toISOString())}` : "…"}
        </div>
      </div>

      {loading && !data && (
        <p className="text-slate-600 text-sm">Live status la rahe hain…</p>
      )}
      {error && (
        <div className={`${cardCls} border-red-300`}>
          <p className="text-red-600 text-sm">{error}</p>
          <button
            onClick={reload}
            className="mt-2 text-xs underline underline-offset-2 text-slate-600 hover:text-slate-900"
          >
            Dobara try karo
          </button>
        </div>
      )}

      {data && (
        <>
          {/* automation checklist — pipeline ke 9 steps + live activity */}
          <AutomationChecklist />

          {/* abhi chal raha hai */}
          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">
              Abhi chal raha hai
            </h2>
            {data.active.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-600">
                  Abhi koi automation nahi chal rahi. Devices tab se{" "}
                  <span className="text-slate-900 font-medium">▶ Run Now</span>{" "}
                  dabao ya schedule ka wait karo.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.active.map((j) => {
                  const hbMin = hbAgeMin(j.last_heartbeat);
                  const hbCapable = (j.heartbeat_count ?? 0) > 0;
                  const hbDead =
                    hbCapable && hbMin !== null && hbMin >= 10;
                  return (
                  <div key={j.id} className={cardCls}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-sm text-slate-900">{j.device_name}</div>
                      <Pill status={j.status} />
                    </div>
                    <div className="mt-2 text-xs text-slate-600 space-y-1">
                      <div>
                        Kaam: <span className="text-slate-900">{j.type}</span>
                      </div>
                      <div>
                        Shuru hue:{" "}
                        <span className="text-slate-900 font-mono">
                          {elapsed(j.created_at)}
                        </span>{" "}
                        pehle
                      </div>
                      {j.current_step && (
                        <div>
                          Step: <span className="text-slate-900">{j.current_step}</span>
                        </div>
                      )}
                      <div>
                        Phone ki aakhri khabar:{" "}
                        <span className="text-slate-900">
                          {j.last_heartbeat
                            ? timeAgo(j.last_heartbeat)
                            : "abhi tak koi khabar nahi"}
                        </span>
                      </div>
                      {hbDead ? (
                        <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800">
                          📵 Phone se 10+ min se koi jawab nahi — lagta hai atak
                          gaya hai. Ghabrao mat: thodi der me server khud is
                          kaam ko dobara queue karega.
                        </div>
                      ) : (
                        j.last_heartbeat && (
                          <div className="text-emerald-700">
                            ✓ Phone ka signal aa raha hai
                          </div>
                        )
                      )}
                      {j.attempts > 0 && (
                        <div>
                          Koshish: <span className="text-slate-900">{j.attempts}</span>
                        </div>
                      )}
                    </div>
                    {/* LIVE PREVIEW (2026-09-20): phone abhi kya kar raha hai — har 10 sec refresh */}
                    <div className="mt-3">
                      <div className="text-xs font-medium text-slate-700 mb-1">
                        📱 Phone ki live screen:
                      </div>
                      <img
                        key={`preview-${j.device_id}-${Math.floor(Date.now() / 10000)}`}
                        src={`/api/devices/${j.device_id}/live-preview`}
                        alt="Phone live preview"
                        className="w-full rounded-lg border border-slate-200 bg-slate-100"
                        style={{ maxHeight: "400px", objectFit: "contain" }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      <div className="text-[11px] text-slate-500 mt-1">
                        Har 10 sec me refresh hota hai — yahan dikhega app kahan kya kar raha hai
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* devices */}
          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Devices</h2>
            {data.devices.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-600">
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
                      <div className="font-semibold text-sm text-slate-900">{d.device_name}</div>
                      <span className="text-[11px] text-slate-500">
                        {PRESENCE_LABEL[d.presence]}
                      </span>
                      {d.status === "paused" && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-300">
                          paused
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-slate-600 space-y-1">
                      <div>
                        Code:{" "}
                        <span className="font-mono text-base font-extrabold tracking-[0.15em] text-emerald-700" title={d.id}>
                          {d.id.slice(0, 8).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        Last seen:{" "}
                        <span className="text-slate-900">{timeAgo(d.last_seen)}</span>
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
            <h2 className="text-sm font-semibold text-slate-700 mb-2">
              Pichhle 24 ghante
            </h2>
            {data.recent.length === 0 ? (
              <div className={cardCls}>
                <p className="text-sm text-slate-600">
                  Pichhle 24 ghante me koi run nahi hui.
                </p>
              </div>
            ) : (
              <div className={`${cardCls} divide-y divide-slate-200`}>
                {data.recent.map((r) => (
                  <div
                    key={r.id}
                    className="py-2.5 flex items-start justify-between gap-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-slate-900 truncate">
                        {r.device_name}
                      </div>
                      {r.note && (
                        <div className="text-xs text-slate-500 truncate">
                          {r.note}
                        </div>
                      )}
                      <div className="text-[11px] text-slate-500">
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
