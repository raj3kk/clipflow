"use client";

import { useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import { Msg, btnPrimary, cardCls, inputCls } from "../components/ui";
import { Settings } from "@/lib/types";

interface Resp {
  settings: Settings;
  configured: boolean;
  error?: string;
}

type FormState = Pick<
  Settings,
  | "daily_target"
  | "spacing_hours"
  | "notify_email"
  | "pause_on_block"
  | "platforms"
  | "autopilot_enabled"
  | "auto_approve"
>;

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X (Twitter)",
  youtube: "YouTube",
};

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-line"
      } ${disabled ? "opacity-70 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export default function SettingsPage() {
  const { data, loading, error, reload } = useApi<Resp>("/api/settings");
  const [form, setForm] = useState<FormState | null>(null);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  if (loading) return <p className="text-slate-400">Loading settings…</p>;
  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Settings</h1>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          API error: {error}
        </div>
      </div>
    );
  }

  const current: FormState | undefined = form ?? data?.settings;
  if (!current) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Settings</h1>
        <p className="text-slate-400 text-sm">No settings returned by the API.</p>
      </div>
    );
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm({ ...current, [k]: v });
  const setPlatform = (k: string, v: boolean) =>
    setForm({ ...current, platforms: { ...current.platforms, [k]: v } });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg("Saving…");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) {
      setMsg("Settings saved.");
      setForm(null);
      reload();
    } else {
      setMsg(`Error: ${d.error ?? res.status}`);
    }
  };

  const platformKeys = Object.keys({ ...PLATFORM_LABELS, ...current.platforms });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-slate-400 text-sm mb-6">Autopilot limits &amp; platforms</p>

      {data && !data.configured && <SetupBanner />}
      <Msg msg={msg} />

      <form onSubmit={save} className={`${cardCls} grid gap-5 max-w-2xl`}>
        <label className="text-sm block">Daily target (submissions/day)
          <input
            type="number"
            min={1}
            max={10}
            value={current.daily_target}
            onChange={(e) => set("daily_target", Number(e.target.value))}
            className={inputCls}
          />
        </label>

        <label className="text-sm block">Spacing between posts (hours)
          <input
            type="number"
            min={1}
            step="any"
            value={current.spacing_hours}
            onChange={(e) => set("spacing_hours", Number(e.target.value))}
            className={inputCls}
          />
          <span className="text-xs text-slate-500">
            Minimum gap enforced by the scheduler between two posts.
          </span>
        </label>

        <label className="text-sm block">Notify email
          <input
            type="email"
            value={current.notify_email ?? ""}
            onChange={(e) => set("notify_email", e.target.value || null)}
            placeholder="owner@example.com"
            className={inputCls}
          />
        </label>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-4">
          <div>
            <div className="text-sm font-semibold">Autopilot agent</div>
            <p className="text-xs text-slate-500 mt-1">
              ON rakho to agent khud campaign chunta hai, viral moment nikalta
              hai, clip render karta hai, post karta hai aur Whop me submit
              karta hai — bina kuch manual kiye. Sirf action-block ya OTP jaisi
              rukavaton par rukkar aapko batayega.
            </p>
          </div>
          <Toggle
            checked={current.autopilot_enabled ?? true}
            onChange={(v) => set("autopilot_enabled", v)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-4">
          <div>
            <div className="text-sm font-semibold">Auto-approve previews</div>
            <p className="text-xs text-slate-500 mt-1">
              Render ke baad QA-passed preview ko agent khud approve karke
              posting pipeline me bhej dega. OFF rakho to har clip aapke
              approval ka wait karega.
            </p>
          </div>
          <Toggle
            checked={current.auto_approve ?? true}
            onChange={(v) => set("auto_approve", v)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-4">
          <div>
            <div className="text-sm font-semibold">Pause on action-block</div>
            <p className="text-xs text-slate-500 mt-1">
              Locked ON — if Instagram rate-limits or action-blocks the account,
              the autopilot pauses itself and notifies the owner instead of
              risking the account. This guard cannot be turned off.
            </p>
          </div>
          <Toggle checked disabled />
        </div>

        <div>
          <div className="text-sm font-semibold mb-2">Platforms</div>
          <div className="grid gap-2">
            {platformKeys.map((key) => (
              <div key={key} className="flex items-center justify-between rounded-lg border border-line p-3">
                <span className="text-sm">{PLATFORM_LABELS[key] ?? key}</span>
                <Toggle
                  checked={Boolean(current.platforms[key])}
                  onChange={(v) => setPlatform(key, v)}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Only enabled platforms are used for posting.
          </p>
        </div>

        <button type="submit" disabled={saving} className={`${btnPrimary} justify-self-start`}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </div>
  );
}
