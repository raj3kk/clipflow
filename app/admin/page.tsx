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
  users: { id: string; email: string; created_at: string; campaigns: number; clips: number; posts: number; submissions: number }[];
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

  if (gate === "loading") return <p className="text-slate-600">Loading…</p>;

  if (gate === "denied") {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-bold mb-2">Access denied</h1>
        <p className="text-sm text-slate-600">Ye area sirf admin ke liye hai.</p>
      </div>
    );
  }

  if (gate === "notConfigured") {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-bold mb-2">Admin panel tayyar hai — password bacha hai</h1>
        <p className="text-sm text-slate-600 mb-3">
          Vercel me <code className="text-amber-700">ADMIN_PANEL_PASSWORD</code> environment variable
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
        <p className="text-sm text-slate-600 mb-4">Admin password dalo.</p>
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
            <div className="text-xs text-slate-600">{label}</div>
          </div>
        ))}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-600">
                <th className="py-1 pr-3">Email</th><th className="py-1 pr-3">Joined</th>
                <th className="py-1 pr-3">Campaigns</th><th className="py-1 pr-3">Clips</th>
                <th className="py-1 pr-3">Posts</th><th className="py-1 pr-3">Submissions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map((u) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="py-1 pr-3"><a className="text-emerald-700 underline" href={`/admin/users/${u.id}`}>{u.email}</a></td>
                  <td className="py-1 pr-3 text-slate-600">{fmtDate(u.created_at)}</td>
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
          <p className="text-sm text-slate-600">Kuch pending nahi hai.</p>
        ) : (
          <ul className="text-sm grid gap-2">
            {(data?.pendingInterventions ?? []).map((i) => (
              <li key={i.id} className="border-b border-line pb-2">
                <span className="font-medium">{i.kind}</span> — {i.email}
                <span className="text-slate-600"> · {age(i.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Connections (sab users)</h2>
        {(data?.connections ?? []).length === 0 ? (
          <p className="text-sm text-slate-600">Koi connection nahi hai.</p>
        ) : (
          <ul className="text-sm grid gap-2">
            {(data?.connections ?? []).map((c) => (
              <li key={c.id} className="border-b border-line pb-2">
                <span className="font-medium">{c.service}</span> — {c.email} — {c.status}
                <span className="text-slate-600"> · verified {c.last_verified ? age(c.last_verified) : "kabhi nahi"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-semibold mb-3">Recent activity</h2>
        <ul className="text-sm grid gap-1">
          {(data?.recentActivity ?? []).map((a) => (
            <li key={a.id} className="text-slate-700">
              {a.action} <span className="text-slate-500">· {a.email} · {age(a.created_at)}</span>
            </li>
          ))}
        </ul>
      </div>

      <Msg msg={msg} />

      <OpsAgentCard />
      <AppUpdateCard />
      <WhopOAuthCard />
    </div>
  );
}

// ---------- App Update (AutoClip in-app auto-update) ----------
interface AppRelease {
  version_code: number;
  version_name: string;
  apk_url: string;
  changelog: string;
  force_update: boolean;
  published_at: string;
}

function AppUpdateCard() {
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [versionCode, setVersionCode] = useState("");
  const [versionName, setVersionName] = useState("");
  const [apkUrl, setApkUrl] = useState("");
  const [changelog, setChangelog] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg3, setMsg3] = useState("");

  async function refresh() {
    const r = await fetch("/api/admin/app-releases");
    if (r.ok) {
      const j = await r.json();
      const list: AppRelease[] = j.releases ?? [];
      setReleases(list);
      // version_code auto-suggest: max + 1 (form khali ho to hi)
      setVersionCode((prev) => {
        if (prev) return prev;
        const max = list.reduce((m, x) => Math.max(m, x.version_code), 0);
        return String(max + 1);
      });
    }
  }
  useEffect(() => { refresh(); }, []);

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg3("");
    const r = await fetch("/api/admin/app-releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version_code: Number(versionCode),
        version_name: versionName.trim(),
        apk_url: apkUrl.trim(),
        changelog: changelog.trim(),
        force_update: force,
      }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsg3(j.error || "Publish nahi hua.");
      return;
    }
    setVersionName("");
    setApkUrl("");
    setChangelog("");
    setForce(false);
    setVersionCode("");
    setMsg3(`v${j.version_code} publish ho gaya — app me update dikhne lagega.`);
    await refresh();
  }

  return (
    <div className={cardCls}>
      <h2 className="font-semibold mb-1">App Update (AutoClip)</h2>
      <p className="text-sm text-slate-600 mb-3">
        Naya release publish karo — phone app khud update download karke install prompt dikhayega.
        Flow: <code className="text-xs bg-slate-100 px-1 rounded">tools/publish-apk.sh</code> chalao →
        URL yahan paste karo → Publish.
      </p>
      <form onSubmit={publish} className="grid gap-2 max-w-xl">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm text-slate-600">
            Version code
            <input
              className={inputCls}
              type="number"
              min={1}
              value={versionCode}
              onChange={(e) => setVersionCode(e.target.value)}
              placeholder="20"
            />
          </label>
          <label className="text-sm text-slate-600">
            Version name
            <input
              className={inputCls}
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
              placeholder="0.1.0-p19"
            />
          </label>
        </div>
        <label className="text-sm text-slate-600">
          APK URL (https)
          <input
            className={inputCls}
            value={apkUrl}
            onChange={(e) => setApkUrl(e.target.value)}
            placeholder="https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p19.apk"
            autoComplete="off"
          />
        </label>
        <label className="text-sm text-slate-600">
          Changelog (app me dikhega)
          <textarea
            className={inputCls}
            rows={3}
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder={"• Naya feature\n• Bug fix"}
          />
        </label>
        <label className="text-sm text-slate-700 flex items-center gap-2">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="h-4 w-4"
          />
          Force update — bina update kiye app aage nahi badhegi
        </label>
        <div>
          <button className={btnPrimary} disabled={busy || !versionCode || !versionName.trim() || !apkUrl.trim()}>
            {busy ? "Publishing…" : "Publish release"}
          </button>
        </div>
      </form>
      <Msg msg={msg3} />

      <h3 className="font-semibold mt-4 mb-2 text-sm">Purane releases</h3>
      {releases.length === 0 ? (
        <p className="text-sm text-slate-600">Abhi koi release publish nahi hui hai.</p>
      ) : (
        <ul className="text-sm grid gap-2">
          {releases.map((x) => (
            <li key={x.version_code} className="border-b border-line pb-2">
              <span className="font-medium">v{x.version_name} (code {x.version_code})</span>
              {x.force_update && (
                <span className="ml-2 text-xs font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded">FORCE</span>
              )}
              <span className="text-slate-600"> · {age(x.published_at)}</span>
              <div className="text-xs text-slate-500 break-all">{x.apk_url}</div>
              {x.changelog ? <div className="text-xs text-slate-600 whitespace-pre-line mt-1">{x.changelog}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Whop OAuth app credentials (owner pastes here, no Vercel needed) ----------
const WHOP_REDIRECT_URI = "https://clipflow-webbuilder1.vercel.app/api/oauth/whop/callback";

function WhopOAuthCard() {
  const [st, setSt] = useState<{ configured: boolean; source: string | null; clientIdMasked: string | null } | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg2, setMsg2] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const r = await fetch("/api/admin/whop-oauth");
    if (r.ok) setSt(await r.json());
  }
  useEffect(() => { refresh(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg2("");
    const r = await fetch("/api/admin/whop-oauth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsg2(j.error || "Save nahi hua.");
      return;
    }
    setClientId("");
    setClientSecret("");
    setMsg2("Save ho gaya — ab Connections page se “Login with Whop” kaam karega.");
    await refresh();
  }

  return (
    <div className={cardCls}>
      <h2 className="font-semibold mb-1">Whop OAuth app</h2>
      <p className="text-sm text-slate-600 mb-3">
        Status:{" "}
        {st == null ? "…" : st.configured ? (
          <span className="text-emerald-700 font-medium">
            configured {st.source === "env" ? "(Vercel env)" : "(yahan paste kiya hua)"}
            {st.clientIdMasked ? ` · ${st.clientIdMasked}` : ""}
          </span>
        ) : (
          <span className="text-amber-700 font-medium">not set up yet</span>
        )}
      </p>
      <ol className="text-sm text-slate-600 list-decimal ml-5 grid gap-1 mb-3">
        <li>
          <a className="text-emerald-700 underline" href="https://whop.com/dashboard" target="_blank" rel="noreferrer">
            whop.com/dashboard
          </a>{" "}
          → Developer → Apps → Create app
        </li>
        <li>
          OAuth tab me ye redirect URI <span className="font-medium text-slate-800">exact</span> daalo:{" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded break-all">{WHOP_REDIRECT_URI}</code>{" "}
          <button
            className={btnGhost}
            onClick={() => { navigator.clipboard.writeText(WHOP_REDIRECT_URI); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </li>
        <li>Permissions me <code className="text-xs bg-slate-100 px-1 rounded">oauth:token_exchange</code> enable karo</li>
        <li>Client ID (<code className="text-xs bg-slate-100 px-1 rounded">app_…</code>) aur Client Secret neeche paste karke Save dabao</li>
      </ol>
      <form onSubmit={save} className="grid gap-2 max-w-md">
        <input
          className={inputCls}
          placeholder="Client ID (app_…)"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
        />
        <input
          className={inputCls}
          type="password"
          placeholder="Client Secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="new-password"
        />
        <div>
          <button className={btnPrimary} disabled={busy || !clientId.trim() || !clientSecret.trim()}>
            {busy ? "Saving…" : "Save Whop OAuth app"}
          </button>
        </div>
      </form>
      <Msg msg={msg2} />
      <p className="text-xs text-slate-500 mt-2">
        Secret encrypted save hota hai — kabhi screen ya API se wapas nahi dikhega.
      </p>
    </div>
  );
}

// ---------- Ops Agent (admin ops chat) ----------
interface OpsMsg {
  from: "you" | "bot";
  text: string;
  actions: string[];
}

function OpsAgentCard() {
  const [msgs, setMsgs] = useState<OpsMsg[]>([
    {
      from: "bot",
      text: "Namaste! Main Ops Agent hun. Stuck jobs, cap, devices — sab yahin se dekho. Try karo: 'jobs', 'cap', 'checklist', 'devices'.",
      actions: [],
    },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const m = text.trim();
    if (!m || busy) return;
    setMsgs((p) => [...p, { from: "you", text: m, actions: [] }]);
    setText("");
    setBusy(true);
    const r = await fetch("/api/admin/ops-agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: m }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsgs((p) => [...p, { from: "bot", text: j.error || "Error — dobara try karo.", actions: [] }]);
      return;
    }
    setMsgs((p) => [...p, { from: "bot", text: String(j.reply ?? ""), actions: j.actions_taken ?? [] }]);
  }

  return (
    <div className={cardCls}>
      <h2 className="font-semibold mb-1">Ops Agent</h2>
      <p className="text-sm text-slate-600 mb-3">
        Rule-based ops helper (₹0, koi AI call nahi). Stuck jobs requeue, device pause/unpause — destructive kaam se pehle 'pakka' confirm mangta hai.
      </p>
      <div className="border border-line rounded-lg p-3 mb-3 max-h-80 overflow-y-auto bg-slate-50 grid gap-2">
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm ${m.from === "you" ? "text-right" : ""}`}>
            <div
              className={`inline-block px-3 py-1.5 rounded-xl whitespace-pre-line text-left ${
                m.from === "you" ? "bg-emerald-600 text-white" : "bg-white border border-line text-slate-800"
              }`}
            >
              {m.text}
            </div>
            {m.actions.length > 0 && (
              <div className="text-xs text-emerald-700 mt-1">
                ✓ {m.actions.join(" · ")}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-xs text-slate-500">Soch raha hun…</p>}
      </div>
      <form onSubmit={send} className="flex gap-2">
        <input
          className={inputCls}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Likho: jobs, cap, checklist, devices, pause <device>…"
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !text.trim()} className={btnPrimary}>
          Bhejo
        </button>
      </form>
      <div className="flex flex-wrap gap-2 mt-2">
        {["jobs", "cap", "checklist", "devices", "help"].map((q) => (
          <button
            key={q}
            type="button"
            className={btnGhost}
            onClick={() => { setText(q); }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
