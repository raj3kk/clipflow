"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppMode, MODE_EVENT, getMode, setMode } from "./mode";

/**
 * v1/v2 segmented toggle — ek login se dono models.
 * v1: server-side automation · v2: phone automation (sab separate)
 */
export default function ModeToggle({ compact }: { compact?: boolean }) {
  const [mode, setModeState] = useState<AppMode>("v1");
  const router = useRouter();

  useEffect(() => {
    setModeState(getMode());
    const h = (e: Event) =>
      setModeState((e as CustomEvent<AppMode>).detail ?? getMode());
    window.addEventListener(MODE_EVENT, h);
    return () => window.removeEventListener(MODE_EVENT, h);
  }, []);

  const pick = (m: AppMode) => {
    if (m === mode) return;
    setMode(m);
    setModeState(m);
    router.push(m === "v2" ? "/devices" : "/");
  };

  const btn = (m: AppMode, label: string, title: string) => (
    <button
      onClick={() => pick(m)}
      title={title}
      className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-bold tracking-wide transition-all ${
        mode === m
          ? "bg-emerald-600 text-white shadow-sm"
          : "text-slate-500 hover:text-slate-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={compact ? "" : "grid gap-1.5"}>
      <div
        className={`flex gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 ${
          compact ? "w-[104px]" : ""
        }`}
      >
        {btn("v1", "v1", "Server automation (campaigns → clips → post)")}
        {btn("v2", "v2", "Phone automation (app cookies, schedule, Run Now)")}
      </div>
      {!compact && (
        <p className="text-[11px] leading-snug text-slate-500">
          {mode === "v1"
            ? "v1 · server-side clipping automation"
            : "v2 · phone automation — sara data v1 se separate"}
        </p>
      )}
    </div>
  );
}
