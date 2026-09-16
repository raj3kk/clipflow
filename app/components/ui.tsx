// Shared UI primitives — dark-theme card style used across all tabs.

export const inputCls =
  "mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-accent";

export const btnPrimary =
  "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";

export const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs text-slate-300 hover:bg-line disabled:opacity-50";

export const btnDanger =
  "rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50";

export const cardCls = "rounded-xl border border-line bg-panel p-5";

export function Msg({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div className="mb-4 rounded-lg border border-line bg-panel p-3 text-sm text-slate-200">
      {msg}
    </div>
  );
}

export function fmtDT(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** "3h 12m" / "45m" / "in 2h 5m" countdown from a target timestamp. */
export function countdown(target: string | null | undefined): string {
  if (!target) return "—";
  const ms = new Date(target).getTime() - Date.now();
  if (isNaN(ms)) return "—";
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const txt = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

/** "2h ago" style relative age. */
export function age(s: string | null | undefined): string {
  if (!s) return "—";
  const ms = Date.now() - new Date(s).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
