/** Status → pill color classes (emerald/gold premium theme). */
export function statusColor(status: string) {
  const s = status.toLowerCase();
  return s === "ok" || s === "submitted" || s === "approved"
    ? "border-emerald-600/30 bg-emerald-50 text-emerald-700"
    : s === "pending" || s === "needed"
      ? "border-amber-600/30 bg-amber-50 text-amber-700"
      : s === "rejected" || s === "error" || s === "failed"
        ? "border-red-300 bg-red-50 text-red-700"
        : "border-line bg-panel text-slate-600";
}

export default function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusColor(status)}`}
    >
      {status}
    </span>
  );
}
