"use client";

import { useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import StatusPill from "@/lib/status-pill";
import { Msg, age, btnPrimary, cardCls, fmtDT, inputCls } from "../components/ui";
import { Intervention } from "@/lib/types";

interface Resp {
  interventions: Intervention[];
  configured: boolean;
  error?: string;
}

function ResolveForm({
  id,
  onResolved,
}: {
  id: string;
  onResolved: (msg: string) => void;
}) {
  const [value, setValue] = useState("");
  const [via, setVia] = useState("dashboard-manual");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`/api/interventions/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, resolved_via: via }),
    });
    const d = await res.json();
    setBusy(false);
    if (res.ok) {
      onResolved("Intervention resolved — the worker will pick it up.");
      setValue("");
    } else {
      onResolved(`Error: ${d.error ?? res.status}`);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 border-t border-line pt-3">
      <label className="text-sm">Value (OTP / code / answer)
        <input
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the code or answer here…"
          className={inputCls}
        />
      </label>
      <label className="text-sm">Resolved via
        <input value={via} onChange={(e) => setVia(e.target.value)} className={inputCls} />
      </label>
      <button type="submit" disabled={busy} className={`${btnPrimary} justify-self-start`}>
        {busy ? "Resolving…" : "Submit & resolve"}
      </button>
    </form>
  );
}

export default function InterventionsPage() {
  const { data, loading, error, reload } = useApi<Resp>("/api/interventions");
  const [msg, setMsg] = useState("");

  if (loading) return <p className="text-slate-400">Loading interventions…</p>;
  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Interventions</h1>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          API error: {error}
        </div>
      </div>
    );
  }

  const all = data?.interventions ?? [];
  const pending = all.filter((i) => i.status === "pending");
  const resolved = all.filter((i) => i.status !== "pending");

  const handled = (m: string) => {
    setMsg(m);
    reload();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Interventions</h1>
      <p className="text-slate-400 text-sm mb-6">
        Worker jab atak jaye (OTP, 2FA, captcha, approval) — yahan fill-in karo.
      </p>

      {data && !data.configured && <SetupBanner />}
      <Msg msg={msg} />

      <h2 className="font-semibold mb-3">Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <div className={`${cardCls} mb-8 text-center py-12`}>
          <div className="text-5xl mb-3">✅</div>
          <div className="font-semibold text-lg">All clear</div>
          <p className="text-sm text-slate-400 mt-1">
            Koi pending intervention nahi hai — worker bina ruke chal raha hai.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 mb-8">
          {pending.map((i) => (
            <div key={i.id} className={`${cardCls} border-gold/40`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs text-gold font-semibold uppercase tracking-wide">
                    {i.kind}
                  </div>
                  <div className="font-semibold mt-1">{i.question}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Raised {age(i.created_at)}
                    {i.clip_id ? ` · clip ${i.clip_id.slice(0, 8)}` : ""}
                    {" · "}
                    {i.email_sent_at
                      ? `owner emailed ${age(i.email_sent_at)}`
                      : "no email sent yet"}
                  </div>
                </div>
                <StatusPill status={i.status} />
              </div>
              <ResolveForm id={i.id} onResolved={handled} />
            </div>
          ))}
        </div>
      )}

      <h2 className="font-semibold mb-3">Resolved history ({resolved.length})</h2>
      {resolved.length === 0 ? (
        <p className="text-sm text-slate-500">Abhi tak kuch resolve nahi hua.</p>
      ) : (
        <div className={`${cardCls} overflow-x-auto`}>
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-line">
                <th className="py-2 pr-3">Kind</th>
                <th className="py-2 pr-3">Question</th>
                <th className="py-2 pr-3">Resolved at</th>
                <th className="py-2">Via</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3 text-slate-400">{i.kind}</td>
                  <td className="py-2 pr-3 text-slate-300">{i.question}</td>
                  <td className="py-2 pr-3 text-slate-400 text-xs">{fmtDT(i.resolved_at)}</td>
                  <td className="py-2 text-slate-500 text-xs">{i.resolved_via ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
