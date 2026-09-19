"use client";

import { useEffect, useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import { age, fmtDT } from "../components/ui";

// Light theme (standard Tailwind) — app/devices ka apna theme.
const cardL = "bg-white border border-slate-200 rounded-xl p-5 shadow-sm";
const btnPL =
  "bg-emerald-600 hover:bg-emerald-700 text-white text-sm px-4 py-2 rounded-lg font-medium disabled:opacity-50";
const btnGL =
  "border border-slate-300 text-slate-700 text-xs px-3 py-2 rounded-lg hover:border-slate-400 bg-white";
const btnRL =
  "border border-red-300 text-red-600 text-xs px-3 py-2 rounded-lg hover:bg-red-50";
const btnRLA =
  "border border-red-500 text-red-700 bg-red-50 text-xs px-3 py-2 rounded-lg";

function LightMsg({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div className="rounded-lg bg-slate-100 border border-slate-200 px-3 py-2 text-sm text-slate-700">
      {msg}
    </div>
  );
}

function LightPill({ status }: { status: string }) {
  const st = status.toLowerCase();
  const cls =
    st === "active" || st === "succeeded" || st === "done" || st === "submitted" || st === "approved"
      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
      : st === "paused" || st === "pending" || st === "needed"
        ? "bg-amber-50 text-amber-700 border-amber-300"
        : st === "disconnected"
          ? "bg-slate-100 text-slate-600 border-slate-300"
          : st === "failed" || st === "blocked" || st === "error" || st === "timeout" || st === "deleted"
            ? "bg-red-50 text-red-700 border-red-300"
            : "bg-slate-100 text-slate-600 border-slate-300";
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  );
}


interface Device {
  id: string;
  device_name: string;
  platform: string;
  app_version: string | null;
  status: string;
  paused_until: string | null;
  last_seen: string | null;
  created_at: string;
  deleted_at: string | null;
  disconnected_at: string | null;
  restore_days_left: number | null;
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
    <div className={cardL}>
      <h2 className="font-semibold mb-2">Add device</h2>
      <p className="text-sm text-slate-600 mb-3">
        Phone pe ClipFlow Agent app kholo → ye code dalo (10 min valid).
        App me Whop + Instagram ek baar login karo — bas.
      </p>
      {!code ? (
        <button onClick={make} disabled={busy} className={btnPL}>
          {busy ? "Ban raha hai…" : "Enroll code banao"}
        </button>
      ) : (
        <div>
          <div className="font-mono text-4xl tracking-[0.3em] text-emerald-600 my-2">
            {code}
          </div>
          <p className="text-xs text-slate-500">
            Expires: {expires ? fmtDT(expires) : "—"}
          </p>
        </div>
      )}
      {err && <LightMsg msg={err ?? ""} />}
    </div>
  );
}

function DeviceCard({
  d,
  onSelect,
  selected,
  onChanged,
}: {
  d: Device;
  onSelect: () => void;
  selected: boolean;
  onChanged: () => void;
}) {
  const paused = d.status === "paused";
  const disconnected = d.status === "disconnected";
  const fingerprint = d.id.slice(0, 8).toUpperCase();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const copyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(d.id).catch(() => {});
  };

  const doDisconnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `"${d.device_name}" ko disconnect karein?\nPhone ko koi job nahi milega.`
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/devices/${d.id}/disconnect`, {
        method: "POST",
      });
      const dd = await r.json();
      if (!r.ok) throw new Error(dd.error ?? r.status);
      onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `"${d.device_name}" delete karein?\n7 din ke andar Recently deleted se restore ho sakta hai.`
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/devices/${d.id}`, { method: "DELETE" });
      const dd = await r.json();
      if (!r.ok) throw new Error(dd.error ?? r.status);
      onChanged();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
      className={`${cardL} text-left w-full transition-colors cursor-pointer ${
        selected ? "border-emerald-600/60" : "hover:border-slate-300"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        {/* 8-char device code — sabse upar, BADA: phone app me bhi yahi dikhta hai (deviceId.take(8).uppercase()), dono match karo */}
        <span
          className="font-mono text-3xl font-extrabold tracking-[0.15em] text-emerald-700"
          title={`Full device ID: ${d.id}`}
        >
          {fingerprint}
        </span>
        <LightPill status={d.status} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="font-semibold text-slate-900">{d.device_name}</div>
        <span
          role="button"
          tabIndex={0}
          onClick={copyId}
          onKeyDown={(e) => e.key === "Enter" && copyId(e as unknown as React.MouseEvent)}
          className="text-[10px] text-slate-500 hover:text-slate-700 underline underline-offset-2"
          title="Full device ID copy karo"
        >
          ID copy
        </span>
      </div>
      <div className="text-xs text-slate-600 mt-2 space-y-1">
        <div>
          {d.platform} {d.app_version ? `· v${d.app_version}` : ""} · last seen{" "}
          {d.last_seen ? age(d.last_seen) : "kabhi nahi"}
        </div>
        {paused && d.paused_until && (
          <div className="text-amber-700">
            Auto-paused (action-block) — resumes {fmtDT(d.paused_until)}
          </div>
        )}
        {disconnected && (
          <div className="text-slate-500">
            Disconnected — phone ko koi job nahi milega
          </div>
        )}
      </div>
      <div
        className="mt-3 flex gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {!disconnected && (
          <button onClick={doDisconnect} disabled={busy} className={btnGL}>
            {busy ? "…" : "Disconnect"}
          </button>
        )}
        <button onClick={doDelete} disabled={busy} className={btnRL}>
          {busy ? "…" : "Delete device"}
        </button>
      </div>
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
    </div>
  );
}

interface Schedule {
  mode: "interval" | "times";
  interval_hours?: number;
  times?: string[];
  timezone?: string;
  enabled?: boolean;
  clip?: { video_url?: string; caption?: string; whop_submit_url?: string };
}

interface ScheduleResp {
  schedule: Schedule;
  next_run: string | null;
  last_run: { finished_at: string; status: string } | null;
}

// Schedule time: UI layer 12-hour AM/PM <-> backend 24h "HH:MM" (backend/storage untouched)
function to12h(t24: string): string {
  const m = t24.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t24;
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (h > 23) return t24;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

function to24h(s: string): string | null {
  const t = s.trim();
  // "7:30 PM", "7 PM", "07:30 pm", "7.30 p.m." wagera
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?\s*([aApP])\s*\.?\s*([mM])\s*\.?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m[3].toLowerCase() === "p";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  // fallback: seedha 24h "HH:MM" bhi chalega
  const m2 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m2) {
    const h = parseInt(m2[1], 10);
    const min = parseInt(m2[2], 10);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return null;
}

function fmtNextRun(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "bas abhi (kuch minute me)";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min me (andaza)`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ghante ${m % 60} min me (andaza)`;
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) +
    ", " +
    d.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " (andaza)"
  );
}

function ScheduleCard({ deviceId }: { deviceId: string }) {
  const { data, loading, reload } = useApi<ScheduleResp>(
    `/api/devices/${deviceId}/schedule`
  );
  const [mode, setMode] = useState<"interval" | "times">("interval");
  const [hours, setHours] = useState("12");
  const [times, setTimes] = useState("9:00 AM, 9:00 PM");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (data?.schedule) {
      setMode(data.schedule.mode);
      if (data.schedule.interval_hours) setHours(String(data.schedule.interval_hours));
      if (data.schedule.times)
        setTimes(data.schedule.times.map(to12h).join(", "));
    }
  }, [data]);

  const enabled = data?.schedule?.enabled !== false;

  const save = async (nextEnabled?: boolean) => {
    setSaving(true);
    setMsg(null);
    try {
      const en = nextEnabled ?? enabled;
      // UI me 12-hour AM/PM, backend ko hamesha 24h "HH:MM"
      let times24: string[] | null = null;
      if (mode === "times") {
        const parsed = times
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map(to24h);
        if (parsed.some((p) => p === null)) {
          setMsg(
            "Time samajh nahi aaya — 12-hour AM/PM me likho, jaise: 7:30 PM, 9 AM"
          );
          setSaving(false);
          return;
        }
        times24 = parsed as string[];
      }
      const schedule =
        mode === "interval"
          ? { mode, interval_hours: parseInt(hours, 10), enabled: en }
          : {
              mode,
              times: times24,
              timezone: "Asia/Calcutta",
              enabled: en,
            };
      const r = await fetch(`/api/devices/${deviceId}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setMsg(
        en
          ? "Schedule save ho gaya — server agle slot pe khud job banayega."
          : "Schedule band kar diya — ab koi auto run nahi hoga (sirf Run Now)."
      );
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const removeSchedule = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    setConfirmDel(false);
    setSaving(true);
    try {
      const r = await fetch(`/api/devices/${deviceId}/schedule`, {
        method: "DELETE",
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setMsg("Schedule hata diya — ab koi auto run nahi hoga (sirf Run Now).");
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
      : `roz ${(data.schedule.times ?? []).map(to12h).join(", ")} baje`
    : "…";

  return (
    <div className={cardL}>
      <div className="flex items-center justify-between mb-1">
        <div className="font-semibold text-sm">Schedule</div>
        {data && (
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full border ${
              enabled
                ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
                : "bg-slate-100 text-slate-500 border border-slate-300"
            }`}
          >
            {enabled ? "chalu hai" : "band hai"}
          </span>
        )}
      </div>

      {/* status: automation shuru hui ya sirf schedule hai */}
      <div className="text-xs text-slate-600 mb-3 space-y-1">
        <div>
          Abhi: <span className="text-slate-900">{loading ? "…" : current}</span>
          {enabled && data?.next_run && (
            <>
              {" "}· agla run:{" "}
              <span className="text-slate-900 font-medium">
                {fmtNextRun(data.next_run)}
              </span>
            </>
          )}
        </div>
        <div>
          {data?.last_run ? (
            <>
              Pichhli automation:{" "}
              <span className="text-slate-900">
                {age(data.last_run.finished_at)} pehle ({data.last_run.status})
              </span>
            </>
          ) : (
            !loading && (
              <span className="text-amber-700">
                Abhi tak koi automation nahi chali — sirf schedule hai.
              </span>
            )
          )}
        </div>
        {!enabled && !loading && (
          <div className="text-slate-500">
            Schedule band hai — server koi auto job nahi banayega. Sirf ▶ Run
            Now se chalega.
          </div>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        {(["interval", "times"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`text-xs px-3 py-1.5 rounded-lg border ${
              mode === m
                ? "border-emerald-600 text-emerald-700"
                : "border-slate-200 text-slate-600"
            }`}
          >
            {m === "interval" ? "Har N ghante" : "Fixed times"}
          </button>
        ))}
      </div>
      {mode === "interval" ? (
        <label className="text-xs text-slate-600 block mb-3">
          Interval (ghante, 1–48):{" "}
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="bg-white border border-slate-300 rounded-lg px-2 py-1 w-20 text-slate-900 ml-1"
            inputMode="numeric"
          />
        </label>
      ) : (
        <label className="text-xs text-slate-600 block mb-3">
          Times (12-hour, AM/PM, comma se alag):{" "}
          <input
            value={times}
            onChange={(e) => setTimes(e.target.value)}
            placeholder="7:30 AM, 7:30 PM"
            className="bg-white border border-slate-300 rounded-lg px-2 py-1 w-52 text-slate-900 ml-1"
          />
        </label>
      )}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => save()} disabled={saving} className={btnPL}>
          {saving ? "Save…" : "Schedule save karo"}
        </button>
        {data && (
          <button
            onClick={() => save(!enabled)}
            disabled={saving}
            className="text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:border-slate-400"
          >
            {enabled ? "Band karo" : "Chalu karo"}
          </button>
        )}
        <button
          onClick={removeSchedule}
          onBlur={() => setConfirmDel(false)}
          disabled={saving}
          className={`text-xs px-3 py-2 rounded-lg border ${
            confirmDel
              ? "border-red-500 text-red-600 bg-red-500/10"
              : "border-slate-200 text-slate-500 hover:text-red-600 hover:border-red-300"
          }`}
        >
          {confirmDel ? "Pakka? dobara dabao" : "Schedule hatao"}
        </button>
      </div>
      {msg && <p className="text-xs text-slate-700 mt-2">{msg}</p>}
      <p className="text-[11px] text-slate-600 mt-2">
        Server har 15 min me schedule check karke khud job banata hai; phone
        poll karke utha leta hai (FCM ho to turant).
      </p>
    </div>
  );
}

function CancelJobButton({
  deviceId,
  jobId,
  onDone,
}: {
  deviceId: string;
  jobId: string;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/devices/${deviceId}/jobs/${jobId}`, {
        method: "DELETE",
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      onDone();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Cancel failed");
      setBusy(false);
    }
  };

  return (
    <button
      onClick={cancel}
      onBlur={() => setConfirm(false)}
      disabled={busy}
      className={`text-xs px-3 py-1.5 rounded-lg border ${
        confirm
          ? "border-red-500 text-red-700 bg-red-50"
          : "border-slate-200 text-slate-600 hover:border-red-300 hover:text-red-600"
      }`}
    >
      {busy ? "Hata raha…" : confirm ? "Pakka? dobara dabao" : "Hatao"}
    </button>
  );
}

function DeleteDeviceButton({ deviceId }: { deviceId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const del = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      window.location.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <div className={`${cardL} border-red-200`}>
      <div className="font-semibold text-sm mb-1 text-red-600">Danger zone</div>
      <p className="text-xs text-slate-500 mb-3">
        Device soft-delete hoga — 7 din ke andar neeche "Recently deleted" se
        restore ho sakta hai. Jobs, runs aur screenshots bane rahenge; 7 din
        baad hamesha ke liye delete ho jayega.
      </p>
      <button
        onClick={del}
        onBlur={() => setConfirm(false)}
        disabled={busy}
        className={`text-xs px-4 py-2 rounded-lg border ${
          confirm
            ? "border-red-500 text-red-700 bg-red-50"
            : "border-red-300 text-red-600 hover:bg-red-50"
        }`}
      >
        {busy ? "Hata raha hai…" : confirm ? "Pakka? dobara dabao" : "Device hatao"}
      </button>
      {msg && <p className="text-xs text-red-600 mt-2">{msg}</p>}
    </div>
  );
}

/** Pipeline stage → user ko dikhne wala Hindi label (KAM 2). */
const STAGE_LABEL: Record<string, string> = {
  taiyaar_ho_raha: "Taiyaar ho raha hai",
  campaign_chun_rahe: "Campaign chun rahe hain",
  video_download: "Video download ho rahi hai",
  clip_ban_raha: "Clip ban raha hai",
  upload_ho_raha: "Upload ho raha hai",
  phone_ko_bhej_rahe: "Phone ko bhej rahe hain",
  ho_gaya: "Ho gaya",
};

/** stage_at se elapsed: "3 min se" / "45 s se" */
function stageElapsed(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  );
  if (s < 60) return `${s} s se`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min se`;
  return `${Math.floor(m / 60)} h ${m % 60} min se`;
}

/** Pipeline fail ka user-friendly kaaran — technical note kabhi raw nahi dikhta. */
function pipeFailLabel(p: {
  note: string | null;
  attempts: number;
  next_retry_at: string | null;
}): string {
  if (p.note?.includes("cap_full_24h"))
    return "Aaj ke 4 runs poore ho gaye — kal phir try karein";
  if (p.next_retry_at)
    return `fail hui — dobara koshish ho rahi hai (${p.attempts}/3)`;
  if ((p.attempts ?? 0) >= 3) return "3 baar koshish ke baad fail hui";
  if (p.note?.includes("dobara koshish"))
    return `fail hui — dobara koshish ho rahi hai (${p.attempts}/3)`;
  return "fail hui";
}

/** Hindi relative time: "5 min" / "2 ghante" / "abhi-abhi" */
function hindiAgo(iso: string | null): string {
  if (!iso) return "kabhi nahi";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "kabhi nahi";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "abhi-abhi";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ghante`;
  return `${Math.floor(h / 24)} din`;
}

/**
 * KAM 4 — active phone job ke liye heartbeat progress (bina app update ke).
 * device.last_seen se: "Phone pe chal raha hai — aakhri halchal X pehle".
 * 30+ min stale → honest warning.
 */
function PhoneProgress({
  jobStatus,
  runStatus,
  lastSeen,
}: {
  jobStatus: string;
  runStatus: string | undefined;
  lastSeen: string | null;
}) {
  const active =
    ["queued", "dispatched", "running"].includes(jobStatus) ||
    runStatus === "running";
  if (!active) return null;
  const staleMs = lastSeen
    ? Date.now() - new Date(lastSeen).getTime()
    : Infinity;
  if (!lastSeen || staleMs > 30 * 60 * 1000) {
    return (
      <p className="mt-2 text-xs text-amber-700">
        ⚠{" "}
        {lastSeen
          ? `Phone se ${hindiAgo(lastSeen)} se jawab nahi aa raha`
          : "Phone se abhi tak jawab nahi aaya"}{" "}
        — app khula hai na check karo
      </p>
    );
  }
  const ago = hindiAgo(lastSeen);
  return (
    <p className="mt-2 text-xs text-slate-600">
      {ago === "abhi-abhi"
        ? "Phone pe chal raha hai — abhi halchal hui ✓"
        : `Phone pe chal raha hai — aakhri halchal ${ago} pehle`}
    </p>
  );
}

function JobsPanel({ deviceId }: { deviceId: string }) {
  const { data, loading, error, reload } = useApi<JobsResp>(
    `/api/devices/${deviceId}/jobs`
  );
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [pipe, setPipe] = useState<{
    id: string;
    status: string;
    note: string | null;
    stage: string | null;
    stage_at: string | null;
    attempts: number;
    next_retry_at: string | null;
  } | null>(null);

  const fetchPipeline = async () => {
    try {
      const r = await fetch(`/api/devices/${deviceId}/run-pipeline`);
      const d = await r.json();
      if (r.ok) setPipe(d.request ?? null);
    } catch {
      /* silent */
    }
  };

  // Mount pe latest request dikhao; pending/running pe poll karo.
  useEffect(() => {
    fetchPipeline();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pipe || (pipe.status !== "pending" && pipe.status !== "running"))
      return;
    const t = setInterval(fetchPipeline, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipe?.id, pipe?.status]);

  /** Run Now → POORA pipeline (campaign → render → IG → Whop). Koi manual field nahi. */
  const runPipeline = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const r = await fetch(`/api/devices/${deviceId}/run-pipeline`, {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setRunMsg("Pipeline shuru ho gayi.");
      await fetchPipeline();
    } catch (e) {
      setRunMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <p className="text-slate-600 text-sm">Loading jobs…</p>;
  if (error || !data)
    return <LightMsg msg={error ?? "No data"} />;

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
      <div className={`${cardL} border-emerald-600/40`}>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div>
            <div className="font-bold text-base">Abhi chalao</div>
            <div className="text-xs text-slate-600">
              Jab chahe — schedule ka wait nahi karna
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={togglePause}
              className={`text-base px-8 py-3 rounded-xl font-bold border transition ${
                devPaused
                  ? "bg-amber-50 border border-amber-500 text-amber-700 hover:bg-amber-100"
                  : "bg-emerald-50 border border-emerald-500 text-emerald-700 hover:bg-emerald-100"
              }`}
              title={devPaused ? "Device wapas active karo — automation chalegi" : "Device offline karo — koi job nahi milega"}
            >
              {devPaused ? "\u{1F4A4} Offline — Online karo" : "\u{1F7E2} Online — Offline karo"}
            </button>
            <button
              onClick={runPipeline}
              disabled={running || devPaused}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-base px-8 py-3 rounded-lg font-bold disabled:opacity-50"
            >
              {running ? "Bhej raha hai…" : "▶ Run Now"}
            </button>
          </div>
        </div>
        {devPaused && (
          <p className="text-xs text-amber-700 mb-1">
            Device paused hai — pehle Resume karo, tabhi Run Now chalega.
          </p>
        )}
        {runMsg && <p className="text-xs text-slate-700">{runMsg}</p>}
        {pipe &&
          (() => {
            // Stage 15+ min se na badle to honest stuck hint (KAM 2).
            const stuck =
              pipe.status === "running" &&
              !!pipe.stage_at &&
              Date.now() - new Date(pipe.stage_at).getTime() >
                15 * 60 * 1000;
            const stageLabel =
              pipe.stage && STAGE_LABEL[pipe.stage]
                ? STAGE_LABEL[pipe.stage]
                : null;
            const retrying =
              pipe.status === "pending" &&
              !!pipe.note?.includes("dobara koshish");
            return (
              <div
                className={`mt-2 text-xs px-3 py-2 rounded-lg inline-block ${
                  pipe.status === "done"
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
                    : pipe.status === "failed"
                      ? "bg-red-500/15 text-red-600 border border-red-500/40"
                      : pipe.status === "running"
                        ? "bg-blue-500/15 text-blue-300 border border-blue-500/40"
                        : "bg-amber-500/15 text-amber-700 border border-amber-500/40"
                }`}
              >
                Pipeline:{" "}
                {pipe.status === "pending" &&
                  (retrying
                    ? `Dobara koshish ho rahi hai (${pipe.attempts}/3)…`
                    : "Pipeline shuru ho gayi hai — taiyaar ho rahi hai…")}
                {pipe.status === "running" &&
                  (stageLabel
                    ? `Abhi: ${stageLabel}… (${stageElapsed(pipe.stage_at)})`
                    : "chal rahi hai…")}
                {pipe.status === "running" &&
                  stuck &&
                  " — atak sakta hai, auto-retry lagega"}
                {pipe.status === "done" && "poori ho gayi ✓"}
                {pipe.status === "failed" && pipeFailLabel(pipe)}
              </div>
            );
          })()}
        <p className="text-xs text-slate-500 mt-1">
          "Jab chahe" trigger — cap (4/24h) yahan bhi lagu hota hai.
        </p>
      </div>

      {lastBad?.run && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4">
          <div className="font-bold text-red-600 text-sm mb-1">
            Last automation {lastBad.run.status === "blocked" ? "BLOCK hui" : "FAIL hui"} — kaaran:
          </div>
          <p className="text-sm text-slate-900">
            {lastBad.run.result?.error ?? "kaaran nahi mila"}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Phone pe bhi notification aaya hoga. Neeche poori job list me
            detail + screenshot proof hai.
          </p>
        </div>
      )}

      <ScheduleCard deviceId={deviceId} />

      <div className={cardL}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-sm">
            Automations — last {data.cap_window_hours}h
          </div>
          <div className="text-sm text-slate-700">
            {data.cap_used}/{data.cap_max}
          </div>
        </div>
        <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
          <div
            className="h-full bg-emerald-600 rounded-full"
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
        <div key={j.id} className={cardL}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <span className="font-mono text-sm">{j.type}</span>
              <span className="text-xs text-slate-500 ml-2">
                {fmtDT(j.created_at)} · attempt {j.attempts}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {j.status === "queued" && (
                <CancelJobButton
                  deviceId={deviceId}
                  jobId={j.id}
                  onDone={() => reload()}
                />
              )}
              <LightPill status={j.run?.status ?? j.status} />
            </div>
          </div>
          <PhoneProgress
            jobStatus={j.status}
            runStatus={j.run?.status}
            lastSeen={data.device.last_seen}
          />
          {j.run?.result?.vars?.reel_url && (            <div className="mt-2 text-sm">
              <a
                href={j.run.result.vars.reel_url}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-600 underline break-all"
              >
                {j.run.result.vars.reel_url}
              </a>
            </div>
          )}
          {j.run?.result?.error && (
            <p className="mt-2 text-sm text-red-600">{j.run.result.error}</p>
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
                      className="w-24 h-40 object-cover rounded-lg border border-slate-200 hover:border-emerald-500"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      <DeleteDeviceButton deviceId={deviceId} />
    </div>
  );
}

/** Recently deleted — soft-deleted devices, 7 din ke andar restore. */
function RecentlyDeleted({ onDone }: { onDone: () => void }) {
  const { data, loading, reload } = useApi<DevicesResp>(
    "/api/devices?include_deleted=true"
  );
  const [busy, setBusy] = useState<string | null>(null);

  const deleted = (data?.devices ?? []).filter((d) => d.deleted_at);
  if (loading || deleted.length === 0) return null;

  const restore = async (id: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/devices/${id}/restore`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      reload();
      onDone();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="text-lg font-bold mb-1 text-slate-900">Recently deleted</h2>
      <p className="text-sm text-slate-600 mb-4">
        7 din ke andar restore ho sakte hain — uske baad hamesha ke liye delete
        ho jayenge.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {deleted.map((d) => (
          <div
            key={d.id}
            className={`${cardL} flex items-center justify-between gap-3`}
          >
            <div>
              <div className="font-semibold text-slate-900">{d.device_name}</div>
              <div className="font-mono text-xs font-bold tracking-[0.2em] text-emerald-700" title={d.id}>
                {d.id.slice(0, 8).toUpperCase()}
              </div>
              <div className="text-xs text-slate-500">
                Restore ke liye{" "}
                <span className="font-medium text-slate-700">
                  {d.restore_days_left ?? "?"} din
                </span>{" "}
                baaki
              </div>
            </div>
            <button
              onClick={() => restore(d.id)}
              disabled={busy === d.id}
              className={btnPL}
            >
              {busy === d.id ? "…" : "Restore"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DevicesPage() {
  const devices = useApi<DevicesResp>("/api/devices");
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1 text-slate-900">Devices</h1>
      <p className="text-sm text-slate-600 mb-5">
        Har phone khud uska automation server hai — yahan enroll karo, status
        dekho, proof screenshots verify karo.
      </p>
      {devices.data && !devices.data.configured && <SetupBanner />}

      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <EnrollBox onDone={() => devices.reload()} />
        <div className={cardL}>
          <h2 className="font-semibold mb-2">Kaise kaam karta hai</h2>
          <ol className="text-sm text-slate-600 space-y-1.5 list-decimal list-inside">
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

      {devices.loading && <p className="text-slate-600 text-sm">Loading…</p>}
      {devices.error && <LightMsg msg={devices.error ?? ""} />}

      {(devices.data?.devices?.length ?? 0) > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            {devices.data!.devices.map((d) => (
              <DeviceCard
                key={d.id}
                d={d}
                selected={selected === d.id}
                onSelect={() => setSelected(d.id)}
                onChanged={() => {
                  if (selected === d.id) setSelected(null);
                  devices.reload();
                }}
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

      <RecentlyDeleted onDone={() => devices.reload()} />
    </div>
  );
}
