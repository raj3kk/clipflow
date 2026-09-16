import { statusColor } from "./state";

export default function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusColor(status)}`}
    >
      {status}
    </span>
  );
}
