"use client";

import { useState } from "react";
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

function JobsPanel({ deviceId }: { deviceId: string }) {
  const { data, loading, error } = useApi<JobsResp>(
    `/api/devices/${deviceId}/jobs`
  );
  if (loading) return <p className="text-slate-400 text-sm">Loading jobs…</p>;
  if (error || !data)
    return <Msg msg={error ?? "No data"} />;

  const pct = Math.min(100, Math.round((data.cap_used / data.cap_max) * 100));

  return (
    <div className="space-y-4">
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
      <SetupBanner />

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
