"use client";

import { useEffect, useState } from "react";
import { age, btnGhost, cardCls, fmtDate, Msg } from "../../../components/ui";

interface UserDetail {
  user: { id: string; email: string | null; created_at: string | null };
  settings: Record<string, unknown> | null;
  counts: { campaigns: number; clips: number; posts: number; submissions: number; pendingInterventions: number };
  postsPerDay: Record<string, number>;
  campaigns: { id: string; name: string; sponsor: string; active: boolean; joined: boolean; budget_remaining_usd: number | null }[];
  clips: { id: string; campaign_id: string; status: string; instagram_url: string | null; posted_at: string | null; error: string | null; created_at: string }[];
  posts: { id: string; instagram_url: string; verify_status: string; posted_at: string | null; created_at: string }[];
  submissions: { id: string; instagram_url: string; whop_status: string; views: number | null; earnings_usd: number | null; submitted_at: string | null }[];
  interventions: { id: string; kind: string; status: string; created_at: string; resolved_at: string | null }[];
  connections: { service: string; method: string; label: string | null; status: string; last_verified: string | null }[];
  activity: { actor: string | null; event: string; detail: unknown; ts: string }[];
}

export default function AdminUserPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<UserDetail | null>(null);
  const [denied, setDenied] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/admin/users/${params.id}`);
      if (r.status === 401) {
        setDenied(true);
        return;
      }
      if (!r.ok) {
        setMsg("User detail load nahi hua.");
        return;
      }
      setData(await r.json());
    })();
  }, [params.id]);

  if (denied) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-bold mb-2">Admin unlock karo</h1>
        <p className="text-sm text-slate-600 mb-4">Pehle admin panel unlock karo, phir ye page khulega.</p>
        <a className={btnGhost} href="/admin">Admin panel kholo</a>
      </div>
    );
  }
  if (!data) return <p className="text-slate-600">Loading… <Msg msg={msg} /></p>;

  const c = data.counts;
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{data.user.email ?? "User"}</h1>
          <p className="text-xs text-slate-600">Joined {fmtDate(data.user.created_at)} · <code>{data.user.id.slice(0, 8)}</code></p>
        </div>
        <a className={btnGhost} href="/admin">← Sab users</a>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Campaigns", c.campaigns],
          ["Clips", c.clips],
          ["Posts", c.posts],
          ["Submissions", c.submissions],
          ["Pending inputs", c.pendingInterventions],
        ].map(([label, v]) => (
          <div key={label as string} className={cardCls}>
            <div className="text-2xl font-bold">{v}</div>
            <div className="text-xs text-slate-600">{label}</div>
          </div>
        ))}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Posts per day (pichhle din — 4/day cap)</h2>
        {Object.keys(data.postsPerDay).length === 0 ? (
          <p className="text-sm text-slate-600">Abhi tak koi post nahi.</p>
        ) : (
          <div className="flex flex-wrap gap-2 text-sm">
            {Object.entries(data.postsPerDay).sort().reverse().slice(0, 7).map(([day, n]) => (
              <span key={day} className={`px-2 py-1 rounded ${n > 4 ? "bg-red-900 text-red-700" : "bg-panel border border-line"}`}>
                {day}: {n}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Connections</h2>
        {data.connections.length === 0 ? (
          <p className="text-sm text-slate-600">Koi connection nahi.</p>
        ) : (
          <ul className="text-sm grid gap-1">
            {data.connections.map((x, i) => (
              <li key={i} className="border-b border-line pb-1">
                <span className="font-medium">{x.service}</span> · {x.method} · {x.status}
                <span className="text-slate-600"> · verified {x.last_verified ? age(x.last_verified) : "kabhi nahi"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Submissions</h2>
        {data.submissions.length === 0 ? (
          <p className="text-sm text-slate-600">Koi submission nahi.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-600">
                <th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Views</th>
                <th className="py-1 pr-3">Earning</th><th className="py-1 pr-3">Submitted</th><th className="py-1 pr-3">Link</th>
              </tr></thead>
              <tbody>
                {data.submissions.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="py-1 pr-3">{s.whop_status}</td>
                    <td className="py-1 pr-3">{s.views ?? "—"}</td>
                    <td className="py-1 pr-3">{s.earnings_usd != null ? `$${s.earnings_usd}` : "—"}</td>
                    <td className="py-1 pr-3 text-slate-600">{s.submitted_at ? age(s.submitted_at) : "—"}</td>
                    <td className="py-1 pr-3"><a className="text-emerald-700 underline" href={s.instagram_url} target="_blank" rel="noreferrer">Reel</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Inputs (interventions)</h2>
        {data.interventions.length === 0 ? (
          <p className="text-sm text-slate-600">Koi intervention nahi.</p>
        ) : (
          <ul className="text-sm grid gap-1">
            {data.interventions.map((i) => (
              <li key={i.id} className="border-b border-line pb-1">
                <span className="font-medium">{i.kind}</span> · {i.status}
                <span className="text-slate-600"> · {age(i.created_at)}{i.resolved_at ? ` · resolved ${age(i.resolved_at)}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Recent activity (worker + user)</h2>
        {data.activity.length === 0 ? (
          <p className="text-sm text-slate-600">Koi activity nahi.</p>
        ) : (
          <ul className="text-sm grid gap-1">
            {data.activity.map((a, i) => (
              <li key={i} className="text-slate-700">
                <span className="text-slate-500">[{a.actor ?? "?"}]</span> {a.event}
                <span className="text-slate-500"> · {age(a.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Settings</h2>
        <pre className="text-xs text-slate-600 overflow-x-auto">{JSON.stringify(data.settings ?? {}, null, 2)}</pre>
      </div>

      <Msg msg={msg} />
    </div>
  );
}
