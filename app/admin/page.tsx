"use client";

import { useEffect, useState } from "react";
import { Msg, age, btnGhost, btnPrimary, cardCls, fmtDate, inputCls } from "../components/ui";

interface Overview {
  date: string;
  totals: {
    users: number;
    campaigns: number;
    clips: number;
    posts: number;
    postsToday: number;
    submissions: number;
    pendingInterventions: number;
    connections: number;
  };
  users: { email: string; created_at: string; campaigns: number; clips: number; posts: number; submissions: number }[];
  pendingInterventions: { id: string; email: string; kind: string; status: string; created_at: string }[];
  connections: { id: string; email: string; service: string; status: string; last_verified: string | null }[];
  recentActivity: { id: string; email: string; action: string; created_at: string }[];
}

type Gate = "loading" | "denied" | "notConfigured" | "needPassword" | "ready";

export default function AdminPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<Overview | null>(null);

  async function load() {
    setMsg("");
    const who = await (await fetch("/api/admin/is-owner")).json();
    if (!who.signedIn || !who.isOwner) {
      setGate("denied");
      return;
    }
    if (!who.passwordConfigured) {
      setGate("notConfigured");
      return;
    }
    const r = await fetch("/api/admin/overview");
    if (r.status === 401) {
      setGate("needPassword");
      return;
    }
    if (!r.ok) {
      setMsg("Overview load nahi hua. Dobara try karo.");
      setGate("needPassword");
      return;
    }
    setData(await r.json());
    setGate("ready");
  }

  useEffect(() => {
    load();
  }, []);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const r = await fetch("/api/admin/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsg(j.error || "Password galat hai.");
      return;
    }
    setPassword("");
    await load();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setData(null);
    setGate("needPassword");
  }

  if (gate === "loading") return <p className="text-slate-400">Loading…</p>;

  if (gate === "denied") {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-bold mb-2">Access denied</h1>
        <p className="text-sm text-slate-400">Ye area sirf admin ke liye hai.</p>
      </div>
    );
  }

  if (gate === "notConfigured") {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-bold mb-2">Admin panel tayyar hai — password bacha hai</h1>
        <p className="text-sm text-slate-400 mb-3">
          Vercel me <code className="text-amber-300">ADMIN_PANEL_PASSWORD</code> environment variable
          set karo (Production), phir redeploy karo. Uske baad ye page admin password mangega.
        </p>
        <a className={btnGhost} href="https://vercel.com/webbuilder1/clipflow/settings/environment-variables" target="_blank" rel="noreferrer">
          Vercel → Environment Variables
        </a>
      </div>
    );
  }

  if (gate === "needPassword") {
    return (
      <div className={`${cardCls} max-w-md`}>
        <h1 className="text-xl font-bold mb-2">Admin Panel</h1>
        <p className="text-sm text-slate-400 mb-4">Admin password dalo.</p>
        <form onSubmit={submitPassword} className="grid gap-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className={inputCls}
            autoFocus
          />
          <button type="submit" disabled={busy || !password} className={`${btnPrimary} justify-self-start`}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>
        <Msg msg={msg} />
      </div>
    );
  }

  const t = data?.totals;
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin Panel</h1>
        <button onClick={logout} className={btnGhost}>Lock admin</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Users", t?.users ?? 0],
          ["Campaigns", t?.campaigns ?? 0],
          ["Clips", t?.clips ?? 0],
          ["Posts (total)", t?.posts ?? 0],
          ["Posts (aaj)", t?.postsToday ?? 0],
          ["Submissions", t?.submissions ?? 0],
          ["Pending inputs", t?.pendingInterventions ?? 0],
          ["Connections", t?.connections ?? 0],
        ].map(([label, v]) => (
          <div key={label as string} className={cardCls}>
            <div className="text-2xl font-bold">{v}</div>
            <div className="text-xs text-slate-400">{label}</div>
          </div>
        ))}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1 pr-3">Email</th><th className="py-1 pr-3">Joined</th>
                <th className="py-1 pr-3">Campaigns</th><th className="py-1 pr-3">Clips</th>
                <th className="py-1 pr-3">Posts</th><th className="py-1 pr-3">Submissions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map((u) => (
                <tr key={u.email} className="border-t border-line">
                  <td className="py-1 pr-3">{u.email}</td>
                  <td className="py-1 pr-3 text-slate-400">{fmtDate(u.created_at)}</td>
                  <td className="py-1 pr-3">{u.campaigns}</td>
                  <td className="py-1 pr-3">{u.clips}</td>
                  <td className="py-1 pr-3">{u.posts}</td>
                  <td className="py-1 pr-3">{u.submissions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Pending inputs (sab users)</h2>
        {(data?.pendingInterventions ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">Kuch pending nahi hai.</p>
        ) : (
          <ul className="text-sm grid gap-2">
            {(data?.pendingInterventions ?? []).map((i) => (
              <li key={i.id} className="border-b border-line pb-2">
                <span className="font-medium">{i.kind}</span> — {i.email}
                <span className="text-slate-400"> · {age(i.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Connections (sab users)</h2>
        {(data?.connections ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">Koi connection nahi hai.</p>
        ) : (
          <ul className="text-sm grid gap-2">
            {(data?.connections ?? []).map((c) => (
              <li key={c.id} className="border-b border-line pb-2">
                <span className="font-medium">{c.service}</span> — {c.email} — {c.status}
                <span className="text-slate-400"> · verified {c.last_verified ? age(c.last_verified) : "kabhi nahi"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Recent activity</h2>
        <ul className="text-sm grid gap-1">
          {(data?.recentActivity ?? []).map((a) => (
            <li key={a.id} className="text-slate-300">
              {a.action} <span className="text-slate-500">· {a.email} · {age(a.created_at)}</span>
            </li>
          ))}
        </ul>
      </div>

      <Msg msg={msg} />
    </div>
  );
}
