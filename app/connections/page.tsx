"use client";

import { useEffect, useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import StatusPill from "@/lib/status-pill";
import { Msg, age, btnDanger, btnGhost, btnPrimary, cardCls, inputCls } from "../components/ui";
import { Connection, ConnectionService } from "@/lib/types";

interface Resp {
  connections: Connection[];
  configured: boolean;
  error?: string;
}

type SaveFn = (payload: { method: string; label: string; secret: Record<string, unknown> | null }) => Promise<void>;

function LabelField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="text-sm block">Label
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputCls} />
    </label>
  );
}

// ---------- Instagram: session-cookie paste ----------
const IG_COOKIES = ["sessionid", "csrftoken", "ds_user_id", "datr", "ig_did", "mid"];

function IgCookiesForm({ save }: { save: SaveFn }) {
  const [label, setLabel] = useState("");
  const [rows, setRows] = useState(IG_COOKIES.map((name) => ({ name, value: "" })));
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await save({
      method: "session-cookie",
      label,
      // Worker expects kind:"web" (see WebPoster.login in worker/pipeline_worker.py).
      secret: { kind: "web", cookies: rows.filter((r) => r.name && r.value).map((r) => ({ name: r.name, value: r.value })) },
    });
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="grid gap-2">
      <LabelField value={label} onChange={setLabel} placeholder="@handle" />
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-5 gap-2">
          <input
            value={r.name}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            placeholder="cookie name"
            className={`${inputCls} col-span-2 !mt-0`}
          />
          <input
            value={r.value}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            placeholder="cookie value"
            type="password"
            className={`${inputCls} col-span-3 !mt-0`}
          />
        </div>
      ))}
      <button
        type="button"
        className={`${btnGhost} justify-self-start`}
        onClick={() => setRows([...rows, { name: "", value: "" }])}
      >
        + Add custom cookie
      </button>
      <button type="submit" disabled={busy} className={`${btnPrimary} justify-self-start mt-2`}>
        {busy ? "Saving…" : "Save session cookies"}
      </button>
    </form>
  );
}

// ---------- Instagram: Meta Accounts Center / API ----------
function IgMetaApiForm() {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-slate-400">
        Meta app authorization is <span className="text-amber-300 font-medium">not available</span>:
        the Accounts Center flow dead-ends at “already added” and there is no
        Meta developer app connected to ClipFlow, so there is nothing to
        authorize against. Use <span className="font-medium">Session cookies</span> or{" "}
        <span className="font-medium">Username + password</span> instead — both are
        real, encrypted, and worker-verified.
      </p>
    </div>
  );
}

// ---------- Instagram: username + password ----------
function IgUserPassForm({ save }: { save: SaveFn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await save({
          method: "username-password",
          label: username,
          // Worker expects kind:"credentials" (see WebPoster.login).
          secret: { kind: "credentials", username, password },
        });
        setBusy(false);
        setPassword("");
      }}
    >
      <label className="text-sm block">Username
        <input required value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls} />
      </label>
      <label className="text-sm block">Password
        <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
      </label>
      <p className="text-xs text-slate-500">
        Encrypted server-side with the server key — never stored in the repo.
        If Instagram asks for 2FA, the code request appears under Interventions.
      </p>
      <button type="submit" disabled={busy} className={`${btnPrimary} justify-self-start`}>
        {busy ? "Saving…" : "Save credentials"}
      </button>
    </form>
  );
}

// ---------- Whop: official OAuth ("Login with Whop") ----------
function WhopOAuthForm({ onMsg }: { onMsg: (m: string) => void }) {
  const [status, setStatus] = useState<"checking" | "ready" | "missing">("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/oauth/whop/status")
      .then((r) => r.json())
      .then((d) => setStatus(d.configured ? "ready" : "missing"))
      .catch(() => setStatus("missing"));
  }, []);

  if (status === "checking") {
    return <p className="text-sm text-slate-500">Checking Whop OAuth setup…</p>;
  }

  if (status === "missing") {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-slate-400">
          Whop OAuth is <span className="text-amber-300 font-medium">not set up yet</span>:
          it needs a Whop OAuth app for ClipFlow (one-time setup, ~2 min).
          Whop dashboard → Developer → naya app banao, phir Client ID + Secret{" "}
          <a className="text-sky-400 underline" href="/admin">Admin panel</a> me
          “Whop OAuth app” section me paste karke Save karo.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-slate-400">
        Official Whop sign-in. Whop asks you to approve; ClipFlow stores only
        an access token, encrypted — never your password, no code pasting.
        The worker uses it for campaign checks and submissions.
      </p>
      <div>
        <button
          className={btnPrimary}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onMsg("Opening Whop sign-in…");
            window.location.href = "/api/oauth/whop/start";
          }}
        >
          {busy ? "Opening…" : "Login with Whop"}
        </button>
      </div>
    </div>
  );
}

// ---------- Gmail: Google OAuth (REAL — needs server-side client configured) ----------
function GmailOAuthForm({ onMsg }: { onMsg: (m: string) => void }) {
  const [status, setStatus] = useState<"checking" | "ready" | "missing">("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/oauth/google/status")
      .then((r) => r.json())
      .then((d) => setStatus(d.configured ? "ready" : "missing"))
      .catch(() => setStatus("missing"));
  }, []);

  if (status === "checking") {
    return <p className="text-sm text-slate-500">Checking Google OAuth setup…</p>;
  }

  if (status === "missing") {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-slate-400">
          Google OAuth is <span className="text-amber-300 font-medium">not set up yet</span>:
          it needs a Google Cloud OAuth client for ClipFlow (one-time setup, ~5 min).
          Until then, use <span className="font-medium">App password</span> below —
          it works today. Ask in chat for the setup steps.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-slate-400">
        Real Google sign-in for the Gmail account used for OTP auto-read.
        Google asks you to approve; ClipFlow stores only
        a refresh token, encrypted — never your password.
      </p>
      <div>
        <button
          className={btnPrimary}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onMsg("Opening Google sign-in…");
            window.location.href = "/api/oauth/google/start";
          }}
        >
          {busy ? "Opening…" : "Connect with Google"}
        </button>
      </div>
    </div>
  );
}

// ---------- Gmail: app password ----------
function GmailAppPassForm({ save }: { save: SaveFn }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await save({
          method: "app-password",
          label: email,
          // Worker expects kind:"app_password" + email (see worker/gmail.py).
          secret: { kind: "app_password", email, app_password: pass },
        });
        setBusy(false);
        setPass("");
      }}
    >
      <label className="text-sm block">Account email
        <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" className={inputCls} />
      </label>
      <label className="text-sm block">App password
        <input required type="password" value={pass} onChange={(e) => setPass(e.target.value)} className={inputCls} />
      </label>
      <button type="submit" disabled={busy} className={`${btnPrimary} justify-self-start`}>
        {busy ? "Saving…" : "Save app password"}
      </button>
    </form>
  );
}

// ---------- Content Rewards: cookie paste ----------
function ContentRewardsForm({ save }: { save: SaveFn }) {
  const [label, setLabel] = useState("Content Rewards session");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await save({ method: "session-cookie", label, secret: { cookie_text: text } });
        setBusy(false);
        setText("");
      }}
    >
      <LabelField value={label} onChange={setLabel} />
      <label className="text-sm block">Session / cookie paste
        <textarea required rows={5} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Paste the full Cookie header or session JSON here…"
          className={inputCls} />
      </label>
      <button type="submit" disabled={busy} className={`${btnPrimary} justify-self-start`}>
        {busy ? "Saving…" : "Save session"}
      </button>
    </form>
  );
}

// ---------- Service section ----------
interface MethodDef {
  key: string;
  title: string;
  desc: string;
  form: (p: { save: SaveFn; status?: Connection["status"] }) => React.ReactNode;
}

function ServiceSection({
  title,
  service,
  methods,
  connections,
  onSaved,
  onDeleted,
  onTested,
}: {
  title: string;
  service: ConnectionService;
  methods: MethodDef[];
  connections: Connection[];
  onSaved: (msg: string) => void;
  onDeleted: (msg: string) => void;
  onTested: (msg: string) => void;
}) {
  const [activeMethod, setActiveMethod] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const own = connections.filter((c) => c.service === service);

  const save: SaveFn = async ({ method, label, secret }) => {
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, method, label, secret }),
    });
    const d = await res.json();
    onSaved(res.ok ? `${title}: connection saved.` : `Error: ${d.error ?? res.status}`);
  };

  const del = async (id: string) => {
    if (!confirm("Delete this connection?")) return;
    const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
    const d = await res.json();
    onDeleted(res.ok ? "Connection deleted." : `Error: ${d.error ?? res.status}`);
  };

  const test = async (id: string) => {
    setTestingId(id);
    const res = await fetch(`/api/connections/${id}/test`, { method: "POST" });
    const d = await res.json();
    setTestingId(null);
    if (!res.ok) onTested(`Test error: ${d.error ?? res.status}`);
    else if (d.ok) onTested(`Test passed — fields present. Real verification happens worker-side.`);
    else onTested(`Test failed: ${d.detail ?? "missing fields"}`);
  };

  const active = methods.find((m) => m.key === activeMethod);

  return (
    <div className={`${cardCls} mb-6`}>
      <h2 className="font-semibold text-lg mb-4">{title}</h2>

      {own.length > 0 ? (
        <div className="space-y-2 mb-5">
          {own.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {c.label} <span className="text-slate-500 font-normal">· {c.method}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  last verified {c.last_verified ? age(c.last_verified) : "never"}
                  {" · "}
                  {c.has_secret ? (
                    <span className="text-emerald-300">🔒 secret stored</span>
                  ) : (
                    <span className="text-slate-500">○ no secret</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusPill status={c.status} />
                <button
                  className={btnGhost}
                  disabled={testingId === c.id}
                  onClick={() => test(c.id)}
                  title="Field validation — real verification happens worker-side"
                >
                  {testingId === c.id ? "Testing…" : "Test"}
                </button>
                <button
                  className={btnGhost}
                  onClick={() => setActiveMethod(c.method)}
                  title="Reconnect / update this connection"
                >
                  Reconnect
                </button>
                <button className={btnDanger} onClick={() => del(c.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500 mb-5">No {title} connection yet — pick a method below.</p>
      )}

      <div className="text-xs text-slate-500 mb-2">Connection method</div>
      <div className="grid sm:grid-cols-3 gap-2 mb-4">
        {methods.map((m) => (
          <button
            key={m.key}
            onClick={() => setActiveMethod(activeMethod === m.key ? null : m.key)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              activeMethod === m.key
                ? "border-accent bg-accent/10"
                : "border-line hover:border-slate-500"
            }`}
          >
            <div className="text-sm font-semibold">{m.title}</div>
            <div className="text-xs text-slate-500 mt-1">{m.desc}</div>
          </button>
        ))}
      </div>

      {active && (
        <div className="rounded-lg border border-line p-4 bg-ink/40">
          <div className="text-sm font-semibold mb-3">{active.title}</div>
          {active.form({ save, status: own.find((c) => c.method === active.key)?.status })}
        </div>
      )}
    </div>
  );
}

export default function ConnectionsPage() {
  const { data, loading, error, reload } = useApi<Resp>("/api/connections");
  const [msg, setMsg] = useState("");

  // Show OAuth redirect results (e.g. ?oauth=ok / ?oauth=error&detail=...).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get("oauth");
    if (r === "ok") {
      setMsg(`✅ Google sign-in successful — Gmail connected${q.get("service") ? ` (${q.get("service")})` : ""}.`);
      reload();
    } else if (r === "error") {
      setMsg(`Google sign-in failed: ${q.get("detail") ?? "unknown error"}`);
    }
    if (r) {
      q.delete("oauth"); q.delete("detail"); q.delete("service");
      const rest = q.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
  }, []);

  if (loading) return <p className="text-slate-400">Loading connections…</p>;
  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Connections</h1>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          API error: {error}
        </div>
      </div>
    );
  }

  const connections = data?.connections ?? [];
  const handled = (m: string) => {
    setMsg(m);
    reload();
  };

  const services: { title: string; service: ConnectionService; methods: MethodDef[] }[] = [
    {
      title: "Instagram",
      service: "instagram",
      methods: [
        { key: "session-cookie", title: "Session cookies", desc: "Paste sessionid, csrftoken…", form: (p) => <IgCookiesForm {...p} /> },
        { key: "meta-api", title: "Meta Accounts Center / API", desc: "Not available — see note", form: () => <IgMetaApiForm /> },
        { key: "username-password", title: "Username + password", desc: "Encrypted; 2FA via Interventions", form: (p) => <IgUserPassForm {...p} /> },
      ],
    },
    {
      title: "Whop",
      service: "whop",
      methods: [
        { key: "oauth", title: "Login with Whop", desc: "Official Whop OAuth — recommended", form: () => <WhopOAuthForm onMsg={setMsg} /> },
      ],
    },
    {
      title: "Gmail",
      service: "gmail",
      methods: [
        { key: "oauth", title: "Google OAuth", desc: "Real Google sign-in", form: () => <GmailOAuthForm onMsg={setMsg} /> },
        { key: "app-password", title: "App password", desc: "16-char app password", form: (p) => <GmailAppPassForm {...p} /> },
      ],
    },
    {
      title: "Content Rewards",
      service: "content_rewards",
      methods: [
        { key: "session-cookie", title: "Session / cookie paste", desc: "Paste session text", form: (p) => <ContentRewardsForm {...p} /> },
      ],
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Connections</h1>
      <p className="text-slate-400 text-sm mb-6">
        Instagram + Whop + Gmail + Content Rewards login health — worker har run me verify karta hai.
      </p>

      {data && !data.configured && <SetupBanner />}
      <Msg msg={msg} />

      <div className="mb-6 rounded-xl border border-line bg-panel p-4 text-xs text-slate-400">
        🔐 Secrets are encrypted with the server key and never stored in the repo.
        Secret values are never rendered back to this UI.
      </div>

      {services.map((s) => (
        <ServiceSection
          key={s.service}
          title={s.title}
          service={s.service}
          methods={s.methods}
          connections={connections}
          onSaved={handled}
          onDeleted={handled}
          onTested={handled}
        />
      ))}
    </div>
  );
}
