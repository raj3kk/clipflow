// ClipFlow autopilot state — read from state/dashboard.json in the repo.
// The autopilot (cron worker) updates that file; the site is a read-only dashboard.

export interface ConnStatus {
  account: string;
  status: "ok" | "needed" | "error";
  last_verified: string;
  note: string;
}

export interface Campaign {
  id: string;
  name: string;
  sponsor: string;
  payout_per_1k_usd: number;
  budget_remaining_usd: number | null;
  min_payout_usd?: number;
  max_payout_usd?: number;
  requirements: string;
  caption_template: string;
  hashtags: string[];
}

export interface RunStep {
  t: string;
  msg: string;
}

export interface Run {
  id: string;
  started_at: string;
  status: string;
  steps: RunStep[];
  reel_url?: string;
  whop_status?: string;
  error?: string;
}

export interface Submission {
  campaign: string;
  instagram_url: string;
  status: string;
  submitted_at: string;
  views: number | null;
}

export interface DashboardState {
  updated_at: string;
  today: { date: string; submitted: number; target: number };
  connections: { instagram: ConnStatus; whop: ConnStatus };
  campaigns: Campaign[];
  runs: Run[];
  submissions: Submission[];
  protected_urls: string[];
  guards: string[];
}

const RAW =
  "https://raw.githubusercontent.com/raj3kk/clipflow/main/state/dashboard.json";

export async function getDashboard(): Promise<DashboardState | null> {
  try {
    const r = await fetch(RAW, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as DashboardState;
  } catch {
    return null;
  }
}

export function statusPill(status: string) {
  const s = status.toLowerCase();
  const color =
    s === "ok" || s === "submitted" || s === "approved"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : s === "pending" || s === "needed"
        ? "border-gold/40 bg-gold/10 text-gold"
        : s === "rejected" || s === "error" || s === "failed"
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : "border-line bg-panel text-slate-300";
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {status}
    </span>
  );
}
