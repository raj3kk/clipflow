"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppMode, MODE_EVENT, getMode, setMode } from "./mode";

/**
 * Upar v1/v2 toggle — ek login se dono models.
 * v1: purana server-side automation · v2: phone (app cookies wala system)
 */
export default function ModeToggle() {
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
    // mode ke hisaab se sahi landing page
    router.push(m === "v2" ? "/devices" : "/");
  };

  const btn = (m: AppMode, label: string, title: string) => (
    <button
      onClick={() => pick(m)}
      title={title}
      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
        mode === m
          ? "bg-accent text-black"
          : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="flex rounded-lg border border-line bg-black/30 p-1 gap-1">
        {btn("v1", "v1", "Server automation (campaigns → clips → post)")}
        {btn("v2", "v2", "Phone automation (app cookies, schedule, Run Now)")}
      </div>
      <div className="text-[11px] text-slate-500 mt-1.5 leading-snug">
        {mode === "v1"
          ? "v1 · server-side clipping automation"
          : "v2 · phone automation — sara data v1 se separate"}
      </div>
    </div>
  );
}
