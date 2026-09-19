"use client";

import { useApi } from "./components/useApi";
import SetupBanner from "./components/SetupBanner";
import AutomationPanel from "./components/AutomationPanel";
import StatusPill from "@/lib/status-pill";
import { cardCls, fmtDT, fmtDate } from "./components/ui";
import { PostRow, isScheduled, postCampaignName, postSubmission } from "./components/models";
import { DayStats, Submission } from "@/lib/types";

interface StatsResp {
  stats: DayStats;
  configured: boolean;
  error?: string;
}
interface PostsResp {
  posts: PostRow[];
  configured: boolean;
  error?: string;
}
interface SubsResp {
  submissions: Submission[];
  configured: boolean;
  error?: string;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={cardCls}>
      <div className="text-3xl font-bold text-accent">{value}</div>
      <div className="text-sm text-slate-600 mt-1">{label}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const stats = useApi<StatsResp>("/api/stats");
  const posts = useApi<PostsResp>("/api/posts");
  const subs = useApi<SubsResp>("/api/submissions");

  const loading = stats.loading || posts.loading || subs.loading;
  if (loading) return <p className="text-slate-600">Loading dashboard…</p>;

  const err = stats.error ?? posts.error ?? subs.error;
  if (err) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-700">
          API error: {err}
        </div>
      </div>
    );
  }

  const s = stats.data?.stats;
  const configured = stats.data?.configured ?? false;
  if (!s) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
        <p className="text-slate-600 text-sm">No stats returned by the API.</p>
      </div>
    );
  }

  const pct = s.target > 0 ? Math.min(100, Math.round((s.submitted / s.target) * 100)) : 0;

  // Views/earnings lookup: submissions link to posts via post_id.
  const subByPost = new Map<string, Submission>();
  (subs.data?.submissions ?? []).forEach((x) => {
    if (x.post_id && !subByPost.has(x.post_id)) subByPost.set(x.post_id, x);
  });

  const allPosts = posts.data?.posts ?? [];
  const posted = allPosts.filter((p) => !isScheduled(p));
  const protectedUrls = allPosts.filter((p) => {
    const sub = subByPost.get(p.id) ?? postSubmission(p);
    return sub?.keep_live_until;
  });

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <span className="text-xs text-slate-500">{fmtDate(s.date)}</span>
      </div>
      <p className="text-slate-600 text-sm mb-6">
        Aaj ka progress — target {s.target}/day · fully automated pipeline
      </p>

      {!configured && <SetupBanner />}

      <div className="mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span>
            Submitted: {s.submitted}/{s.target}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-3 rounded-full bg-line overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Est. earnings (today)" value={`$${s.est_earnings_usd.toFixed(2)}`} />
        <StatCard label="Posts today" value={String(s.posted)} />
        <StatCard label="In pipeline" value={String(s.in_pipeline)} />
        <StatCard label="Submissions today" value={`${s.submitted}/${s.target}`} />
      </div>

      <AutomationPanel />

      <div className={`${cardCls} mb-8 overflow-x-auto`}>
        <h2 className="font-semibold mb-3">Tracking — everything in one place</h2>
        {allPosts.length === 0 ? (
          <p className="text-sm text-slate-500">Abhi koi post nahi hai.</p>
        ) : (
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-line">
                <th className="py-2 pr-3">Reel</th>
                <th className="py-2 pr-3">Campaign</th>
                <th className="py-2 pr-3">Posted at</th>
                <th className="py-2 pr-3">Verify</th>
                <th className="py-2 pr-3">Whop</th>
                <th className="py-2 pr-3 text-right">Views</th>
                <th className="py-2 text-right">Earnings</th>
              </tr>
            </thead>
            <tbody>
              {allPosts.map((p) => {
                const sub = subByPost.get(p.id) ?? postSubmission(p);
                return (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">
                      {p.instagram_url ? (
                        <a href={p.instagram_url} target="_blank" rel="noreferrer" className="text-accent underline">
                          Reel ↗
                        </a>
                      ) : (
                        <span className="text-slate-500">scheduled</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">{postCampaignName(p)}</td>
                    <td className="py-2 pr-3 text-slate-600 text-xs">{fmtDT(p.posted_at)}</td>
                    <td className="py-2 pr-3">
                      {p.verify_status ? <StatusPill status={p.verify_status} /> : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {sub?.whop_status ? (
                        <StatusPill status={sub.whop_status} />
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-700">
                      {sub?.views != null ? sub.views.toLocaleString() : "—"}
                    </td>
                    <td className="py-2 text-right text-slate-700">
                      {sub?.earnings_usd != null ? `$${Number(sub.earnings_usd).toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {protectedUrls.length > 0 && (
        <div className={`${cardCls} mb-8`}>
          <h2 className="font-semibold mb-1">Protected URLs — do NOT delete</h2>
          <p className="text-xs text-slate-500 mb-3">
            Whop submissions must stay live for 30 days — deleting forfeits the submission.
          </p>
          <div className="space-y-2">
            {protectedUrls.map((p) => {
              const sub = subByPost.get(p.id) ?? postSubmission(p);
              return (
                <div key={p.id} className="flex items-center justify-between gap-4 text-sm border-b border-line pb-2 last:border-0 last:pb-0">
                  {p.instagram_url ? (
                    <a href={p.instagram_url} target="_blank" rel="noreferrer" className="text-accent underline truncate">
                      {p.instagram_url}
                    </a>
                  ) : (
                    <span className="text-slate-500 truncate">scheduled · {postCampaignName(p)}</span>
                  )}
                  <span className="text-xs text-gold shrink-0">
                    keep live until {fmtDate(sub?.keep_live_until)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {(s.per_campaign ?? []).map((c) => (
          <div key={c.id} className={cardCls}>
            <div className="font-semibold text-sm">{c.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              ${Number(c.payout_per_1k_usd).toFixed(2)}/1K views
            </div>
            <div className="mt-2 text-lg font-bold text-accent">
              {c.budget_remaining_usd != null
                ? `$${c.budget_remaining_usd.toLocaleString()}`
                : "—"}
              <span className="text-xs font-normal text-slate-500"> budget left</span>
            </div>
          </div>
        ))}
        {(!s.per_campaign || s.per_campaign.length === 0) && posted.length === 0 && (
          <p className="text-sm text-slate-500 md:col-span-2">
            No campaign budget data yet.
          </p>
        )}
      </div>
    </div>
  );
}
