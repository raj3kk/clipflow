"use client";

import { useEffect, useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import StatusPill from "@/lib/status-pill";
import { Msg, age, btnPrimary, cardCls, fmtDT } from "../components/ui";

interface Device {
  id: string;
  device_name: string;
  platform: string;
  app_version: string | null;
  status: string;
  paused_until: string | null;
  last_seen: string | null;
  created_at: string;
}
interface DevicesResp {
  devices: Device[];
  configured: boolean;
  error?: string;
}
interface JobRun {
  status: string;
  result: { vars?: Record<string, string>; error?: string } | null;
  shot_urls: string[];
  finished_at: string;
}
interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  created_at: string;
  run: JobRun | null;
}
interface JobsResp {
  device: Device;
  jobs: Job[];
  cap_used: number;
  cap_max: number;
  cap_window_hours: number;
  error?: string;
}

function EnrollBox({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [expires, setExpires] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/devices/enroll-code", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setCode(d.code);
      setExpires(d.expires_at);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardCls}>
      <h2 className="font-semibold mb-2">Add device</h2>
      <p className="text-sm text-slate-400 mb-3">
        Phone pe ClipFlow Agent app kholo → ye code dalo (10 min valid).
        App me Whop + Instagram ek baar login karo — bas.
      </p>
      {!code ? (
        <button onClick={make} disabled={busy} className={btnPrimary}>
          {busy ? "Ban raha hai…" : "Enroll code banao"}
        </button>
      ) : (
        <div>
          <div className="font-mono text-4xl tracking-[0.3em] text-accent my-2">
            {code}
          </div>
          <p className="text-xs text-slate-500">
            Expires: {expires ? fmtDT(expires) : "—"}
          </p>
        </div>
      )}
      {err && <Msg msg={err ?? ""} />}
    </div>
  );
}

function DeviceCard({ d, onSelect, selected }: { d: Device; onSelect: () => void; selected: boolean }) {
  const paused = d.status === "paused";
  const fingerprint = d.id.slice(0, 8).toUpperCase();
  const copyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(d.id).catch(() => {});
  };
  return (
    <button
      onClick={onSelect}
      className={`${cardCls} text-left w-full transition-colors ${
        selected ? "border-accent/60" : "hover:border-slate-500"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">{d.device_name}</div>
        <StatusPill status={d.status} />
      </div>
      {/* device fingerprint — phone app me bhi yahi dikhta hai, match karo */}
      <div className="mt-2 flex items-center gap-2">
        <span
          className="font-mono text-sm font-bold tracking-[0.2em] magic-text"
          title={d.id}
        >
          {fingerprint}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={copyId}
          onKeyDown={(e) => e.key === "Enter" && copyId(e as unknown as React.MouseEvent)}
          className="text-[10px] text-slate-500 hover:text-slate-300 underline underline-offset-2"
          title="Full device ID copy karo"
        >
          ID copy
        </span>
      </div>
      <div className="text-xs text-slate-400 mt-2 space-y-1">
        <div>
          {d.platform} {d.app_version ? `· v${d.app_version}` : ""} · last seen{" "}
          {d.last_seen ? age(d.last_seen) : "kabhi nahi"}
        </div>
        {paused && d.paused_until && (
          <div className="text-amber-300">
            Auto-paused (action-block) — resumes {fmtDT(d.paused_until)}
          </div>
        )}
      </div>
    </button>
  );
}

interface Schedule {
  mode: "interval" | "times";
  interval_hours?: number;
  times?: string[];
  timezone?: string;
}

function ScheduleCard({ deviceId }: { deviceId: string }) {
  const { data, loading, reload } = useApi<{ schedule: Schedule }>(
    `/api/devices/${deviceId}/schedule`
  );
  const [mode, setMode] = useState<"interval" | "times">("interval");
  const [hours, setHours] = useState("12");
  const [times, setTimes] = useState("09:00, 21:00");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data?.schedule) {
      setMode(data.schedule.mode);
      if (data.schedule.interval_hours) setHours(String(data.schedule.interval_hours));
      if (data.schedule.times) setTimes(data.schedule.times.join(", "));
    }
  }, [data]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const schedule =
        mode === "interval"
          ? { mode, interval_hours: parseInt(hours, 10) }
          : {
              mode,
              times: times.split(",").map((t) => t.trim()).filter(Boolean),
              timezone: "Asia/Calcutta",
            };
      const r = await fetch(`/api/devices/${deviceId}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setMsg("Schedule save ho gaya — phone agli run se naya schedule uthayega.");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const current = data?.schedule
    ? data.schedule.mode === "interval"
      ? `har ${data.schedule.interval_hours} ghante`
      : `roz ${(data.schedule.times ?? []).join(", ")} baje`
    : "…";

  return (
    <div className={cardCls}>
      <div className="font-semibold text-sm mb-1">Schedule</div>
      <p className="text-xs text-slate-400 mb-3">
        Abhi: <span className="text-slate-200">{loading ? "…" : current}</span>
        {" "}(phone WorkManager se chalata hai; Doze me ±10 min drift normal hai)
      </p>
      <div className="flex gap-2 mb-3">
        {(["interval", "times"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              mode === m
                ? "border-accent text-accent"
                : "border-line text-slate-400"
            }`}
          >
            {m === "interval" ? "Har N ghante" : "Fixed times"}
          </button>
        ))}
      </div>
      {mode === "interval" ? (
        <label className="text-xs text-slate-400 block mb-3">
          Interval (ghante, 1–48):{" "}
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="bg-black/30 border border-line rounded-lg px-2 py-1 w-20 text-slate-200 ml-1"
            inputMode="numeric"
          />
        </label>
      ) : (
        <label className="text-xs text-slate-400 block mb-3">
          Times (24h, comma se alag):{" "}
          <input
            value={times}
            onChange={(e) => setTimes(e.target.value)}
            placeholder="09:00, 21:00"
            className="bg-black/30 border border-line rounded-lg px-2 py-1 w-48 text-slate-200 ml-1"
          />
        </label>
      )}
      <button onClick={save} disabled={saving} className={btnPrimary}>
        {saving ? "Save…" : "Schedule save karo"}
      </button>
      {msg && <p className="text-xs text-slate-300 mt-2">{msg}</p>}
    </div>
  );
}

function JobsPanel({ deviceId }: { deviceId: string }) {
  const { data, loading, error } = useApi<JobsResp>(
    `/api/devices/${deviceId}/jobs`
  );
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const runNow = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "automation" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setRunMsg(
        d.via === "fcm"
          ? "Job ban gaya — phone ko push bhej diya, turant chalega."
          : `Job ban gaya — phone agle schedule pe uthayega. (${d.reason ?? ""})`
      );
    } catch (e) {
      setRunMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <p className="text-slate-400 text-sm">Loading jobs…</p>;
  if (error || !data)
    return <Msg msg={error ?? "No data"} />;

  const pct = Math.min(100, Math.round((data.cap_used / data.cap_max) * 100));
  const devPaused = data.device.status === "paused";
  // latest failed/blocked run — user ko sabse upar kaaran dikhe
  const lastBad = data.jobs.find(
    (j) => j.run && (j.run.status === "failed" || j.run.status === "blocked")
  );

  const togglePause = async () => {
    try {
      const r = await fetch(`/api/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: devPaused ? "resume" : "pause" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      window.location.reload();
    } catch (e) {
      setRunMsg(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className={`${cardCls} border-accent/40`}>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div>
            <div className="font-bold text-base">Abhi chalao</div>
            <div className="text-xs text-slate-400">
              Jab chahe — schedule ka wait nahi karna
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={togglePause}
              className="text-xs px-3 py-3 rounded-lg border border-line text-slate-300 hover:border-slate-400"
              title={devPaused ? "Device wapas active karo" : "Device ko rok do (koi job nahi milega)"}
            >
              {devPaused ? "Resume device" : "Pause device"}
            </button>
            <button
              onClick={runNow}
              disabled={running || devPaused}
              className={`${btnPrimary} text-base px-8 py-3 font-bold`}
            >
              {running ? "Bhej raha hai…" : "▶ Run Now"}
            </button>
          </div>
        </div>
        {devPaused && (
          <p className="text-xs text-amber-300 mb-1">
            Device paused hai — pehle Resume karo, tabhi Run Now chalega.
          </p>
        )}
        {runMsg && <p className="text-xs text-slate-300">{runMsg}</p>}
        <p className="text-xs text-slate-500 mt-1">
          "Jab chahe" trigger — cap (4/48h) yahan bhi lagu hota hai.
        </p>
      </div>

      {lastBad?.run && (
        <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-4">
          <div className="font-bold text-red-300 text-sm mb-1">
            Last automation {lastBad.run.status === "blocked" ? "BLOCK hui" : "FAIL hui"} — kaaran:
          </div>
          <p className="text-sm text-slate-200">
            {lastBad.run.result?.error ?? "kaaran nahi mila"}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Phone pe bhi notification aaya hoga. Neeche poori job list me
            detail + screenshot proof hai.
          </p>
        </div>
      )}

      <ScheduleCard deviceId={deviceId} />

      <div className={cardCls}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm">
            Automations — last {data.cap_window_hours}h
          </div>
          <div className="text-sm text-slate-300">
            {data.cap_used}/{data.cap_max}
          </div>
        </div>
        <div className="h-2 rounded-full bg-line overflow-hidden">
          <div
            className="h-full bg-accent rounded-full"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Cap: max {data.cap_max} automations per {data.cap_window_hours}h.
          Naya job cap-full hone pe banta hi nahi (429).
        </p>
      </div>

      {data.jobs.length === 0 && (
        <p className="text-slate-500 text-sm">
          Abhi tak koi automation nahi chali is device pe.
        </p>
      )}

      {data.jobs.map((j) => (
        <div key={j.id} className={cardCls}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <span className="font-mono text-sm">{j.type}</span>
              <span className="text-xs text-slate-500 ml-2">
                {fmtDT(j.created_at)} · attempt {j.attempts}
              </span>
            </div>
            <StatusPill status={j.run?.status ?? j.status} />
          </div>
          {j.run?.result?.vars?.reel_url && (
            <div className="mt-2 text-sm">
              <a
                href={j.run.result.vars.reel_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline break-all"
              >
                {j.run.result.vars.reel_url}
              </a>
            </div>
          )}
          {j.run?.result?.error && (
            <p className="mt-2 text-sm text-red-300">{j.run.result.error}</p>
          )}
          {(j.run?.shot_urls?.length ?? 0) > 0 && (
            <div className="mt-3">
              <div className="text-xs text-slate-500 mb-2">
                Screenshot proof ({j.run!.shot_urls.length})
              </div>
              <div className="flex gap-2 flex-wrap">
                {j.run!.shot_urls.map((u, k) => (
                  <a key={k} href={u} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={u}
                      alt={`proof ${k + 1}`}
                      className="w-24 h-40 object-cover rounded-lg border border-line hover:border-accent"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function DevicesPage() {
  const devices = useApi<DevicesResp>("/api/devices");
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Devices</h1>
      <p className="text-sm text-slate-400 mb-5">
        Har phone khud uska automation server hai — yahan enroll karo, status
        dekho, proof screenshots verify karo.
      </p>
      {devices.data && !devices.data.configured && <SetupBanner />}

      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <EnrollBox onDone={() => devices.reload()} />
        <div className={cardCls}>
          <h2 className="font-semibold mb-2">Kaise kaam karta hai</h2>
          <ol className="text-sm text-slate-400 space-y-1.5 list-decimal list-inside">
            <li>Enroll code banao, phone app me dalo</li>
            <li>App me Whop + Instagram ek baar login karo</li>
            <li>Battery setting me ek tap (guide app me hai)</li>
            <li>Bas — schedule pe phone khud kaam karega</li>
          </ol>
          <p className="text-xs text-slate-500 mt-3">
            Server tumhara password kabhi nahi dekhta — login tumhare phone ke
            andar hota hai.
          </p>
        </div>
      </div>

      {devices.loading && <p className="text-slate-400 text-sm">Loading…</p>}
      {devices.error && <Msg msg={devices.error ?? ""} />}

      {(devices.data?.devices?.length ?? 0) > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            {devices.data!.devices.map((d) => (
              <DeviceCard
                key={d.id}
                d={d}
                selected={selected === d.id}
                onSelect={() => setSelected(d.id)}
              />
            ))}
          </div>
          <div>
            {selected ? (
              <JobsPanel key={selected} deviceId={selected} />
            ) : (
              <p className="text-slate-500 text-sm">
                Kisi device pe click karo — uske jobs + proofs dikhenge.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
