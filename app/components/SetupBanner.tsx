import Link from "next/link";

/** Prominent setup banner — shown when the backend API reports configured:false.
 *  Never shows fake numbers; only setup steps. */
export default function SetupBanner() {
  const steps = [
    "Create a NEW Supabase project at supabase.com (free tier is fine).",
    "In the Supabase SQL editor, run supabase/schema.sql from the clipflow folder.",
    "Set Vercel env vars: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.",
    "On the VM, run worker/run_planner.sh (every 6h) and worker/run_pipeline_watch.sh (every 1 min) via cron — env comes from ~/.config/clipflow/worker.env.",
  ];
  return (
    <div className="mb-6 rounded-xl border border-gold/40 bg-gold/10 p-5">
      <h2 className="font-bold text-gold text-lg mb-1">Supabase not configured</h2>
      <p className="text-sm text-slate-700 mb-3">
        The database is not connected yet, so all numbers below are hidden —
        nothing is faked. Complete the setup to see live data:
      </p>
      <ol className="text-sm text-slate-700 space-y-1.5 list-decimal list-inside">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <Link
        href="/settings"
        className="inline-block mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
      >
        Go to Settings
      </Link>
    </div>
  );
}
