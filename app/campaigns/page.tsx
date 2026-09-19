"use client";

import { useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import StatusPill from "@/lib/status-pill";
import { Msg, btnGhost, btnPrimary, cardCls, inputCls } from "../components/ui";
import { Campaign } from "@/lib/types";

interface Resp {
  campaigns: Campaign[];
  configured: boolean;
  error?: string;
}

const JOIN_OPTIONS = ["not_joined", "waitlist", "needs_user", "joined"];

function CampaignCard({
  c,
  onSaved,
}: {
  c: Campaign;
  onSaved: (msg: string) => void;
}) {
  const [editingBudget, setEditingBudget] = useState(false);
  const [budget, setBudget] = useState(
    c.budget_remaining_usd != null ? String(c.budget_remaining_usd) : ""
  );
  const [joinStatus, setJoinStatus] = useState(
    c.join_status ?? (c.joined ? "joined" : "not_joined")
  );
  const [saving, setSaving] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    const res = await fetch(`/api/campaigns/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    setSaving(false);
    onSaved(res.ok ? "Campaign updated." : `Error: ${d.error ?? res.status}`);
  };

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-lg">{c.name}</h2>
          <p className="text-sm text-slate-600">{c.sponsor}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold text-accent">
            ${c.payout_per_1k_usd.toFixed(2)}
            <span className="text-sm font-normal text-slate-600">/1k</span>
          </div>
          {(c.min_payout_usd != null || c.max_payout_usd != null) && (
            <div className="text-xs text-slate-500">
              payout {c.min_payout_usd != null ? `$${c.min_payout_usd}` : "—"} –{" "}
              {c.max_payout_usd != null ? `$${c.max_payout_usd}` : "—"}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-line px-2 py-1">
          {c.min_seconds}–{c.max_seconds}s
        </span>
        {c.hashtags.map((h) => (
          <span key={h} className="rounded bg-line px-2 py-1 text-accent">
            {h}
          </span>
        ))}
        <StatusPill status={joinStatus} />
        {!c.active && <StatusPill status="inactive" />}
      </div>

      {/* JOIN CTA (Round-7, 2026-09-19): phone ka WebView Whop me logged-in
          hai, isliye planner non-joined campaign pe pehle auto-join job
          bhejta hai. join_status='needs_user' = auto-join ko user ka action
          chahiye (Whop login expire / extra verification). */}
      {joinStatus !== "joined" && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            {joinStatus === "needs_user"
              ? "⚠️ Auto-join ko TUMHARI zaroorat hai — neeche detail dekho."
              : "⚠️ Abhi joined nahi — phone auto-join try karega, ya khud join karo."}
          </p>
          <ol className="mt-1 list-decimal ml-5 text-xs space-y-1">
            <li>
              <b>Auto (phone):</b> planner har tick pe non-joined campaign ke
              liye phone ko join job bhejta hai — app khud Whop pe Join dabata
              hai. Ya manual: Whop pe jaake <b>“Join campaign”</b> dabao{" "}
              {c.campaign_url ? (
                <a
                  href={c.campaign_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline font-semibold"
                >
                  — campaign page kholo ↗
                </a>
              ) : (
                <>— <span className="font-semibold">whop.com/content-rewards</span> pe campaign dhoondo</>
              )}
              .
            </li>
            <li>
              Join ho jaye to yahan neeche <b>Join status = joined</b> set karo
              (auto-join safal hua to ye khud set ho jayega) — uske baad hi
              planner is campaign pe clip banayega.
            </li>
          </ol>
        </div>
      )}

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-700 hover:text-slate-900">
          Brief requirements
        </summary>
        <p className="text-slate-600 mt-2 whitespace-pre-wrap">{c.requirements || "—"}</p>
        {c.caption_template && (
          <p className="text-slate-500 mt-2 text-xs">
            Caption template: <span className="text-slate-600">{c.caption_template}</span>
          </p>
        )}
      </details>

      <div className="mt-4 grid gap-3 md:grid-cols-2 border-t border-line pt-4">
        <div className="text-sm">
          <div className="text-slate-600 mb-1">
            Budget remaining:{" "}
            {editingBudget ? null : (
              <span className="text-slate-800 font-semibold">
                {c.budget_remaining_usd != null
                  ? `$${c.budget_remaining_usd.toLocaleString()}`
                  : "—"}
              </span>
            )}
          </div>
          {editingBudget ? (
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                step="any"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className={inputCls + " !mt-0"}
              />
              <button
                className={btnGhost}
                disabled={saving}
                onClick={() => {
                  patch({ budget_remaining_usd: budget === "" ? null : Number(budget) });
                  setEditingBudget(false);
                }}
              >
                Save
              </button>
              <button className={btnGhost} onClick={() => setEditingBudget(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className={btnGhost} onClick={() => setEditingBudget(true)}>
              Edit budget
            </button>
          )}
        </div>
        <label className="text-sm text-slate-600">
          Join status
          <select
            value={joinStatus}
            disabled={saving}
            onChange={(e) => {
              setJoinStatus(e.target.value);
              patch({ join_status: e.target.value });
            }}
            className={inputCls}
          >
            {JOIN_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(c.brief_url || c.campaign_url) && (
        <div className="mt-3 flex gap-3 text-xs">
          {c.brief_url && (
            <a href={c.brief_url} target="_blank" rel="noreferrer" className="text-accent underline">
              Open brief ↗
            </a>
          )}
          {c.campaign_url && (
            <a href={c.campaign_url} target="_blank" rel="noreferrer" className="text-accent underline">
              Campaign page ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  id: "",
  name: "",
  sponsor: "",
  payout_per_1k_usd: "",
  budget_remaining_usd: "",
  min_seconds: "15",
  max_seconds: "60",
  requirements: "",
  caption_template: "",
  hashtags: "",
  brief_url: "",
  campaign_url: "",
};

export default function CampaignsPage() {
  const { data, loading, error, reload } = useApi<Resp>("/api/campaigns");
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAdd, setShowAdd] = useState(false);
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState(false);

  if (loading) return <p className="text-slate-600">Loading campaigns…</p>;
  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Campaigns</h1>
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-700">
          API error: {error}
        </div>
      </div>
    );
  }

  const campaigns = data?.campaigns ?? [];

  const scoutAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setMsg("Adding campaign…");
    const res = await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: form.id,
        name: form.name,
        sponsor: form.sponsor,
        payout_per_1k_usd: Number(form.payout_per_1k_usd),
        budget_remaining_usd: form.budget_remaining_usd === "" ? null : Number(form.budget_remaining_usd),
        min_seconds: Number(form.min_seconds),
        max_seconds: Number(form.max_seconds),
        requirements: form.requirements,
        caption_template: form.caption_template,
        hashtags: form.hashtags.split(",").map((h) => h.trim()).filter(Boolean),
        brief_url: form.brief_url || null,
        campaign_url: form.campaign_url || null,
      }),
    });
    const d = await res.json();
    setAdding(false);
    if (res.ok) {
      setMsg("Campaign added.");
      setForm(EMPTY_FORM);
      setShowAdd(false);
      reload();
    } else {
      setMsg(`Error: ${d.error ?? res.status}`);
    }
  };

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <button className={btnPrimary} onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Close" : "+ Scout-add campaign"}
        </button>
      </div>
      <p className="text-slate-600 text-sm mb-6">
        {campaigns.length} campaigns · sorted by payout · autopilot sirf{" "}
        <b>joined</b> campaigns pe chalta hai
      </p>

      {data && !data.configured && <SetupBanner />}
      <Msg msg={msg} />

      {showAdd && (
        <form onSubmit={scoutAdd} className={`${cardCls} mb-8 grid gap-3 md:grid-cols-2`}>
          <h2 className="font-semibold md:col-span-2">Scout-add campaign</h2>
          <label className="text-sm">ID (slug)*
            <input required value={form.id} onChange={set("id")} placeholder="perplexity-jre" className={inputCls} />
          </label>
          <label className="text-sm">Name*
            <input required value={form.name} onChange={set("name")} className={inputCls} />
          </label>
          <label className="text-sm">Sponsor
            <input value={form.sponsor} onChange={set("sponsor")} className={inputCls} />
          </label>
          <label className="text-sm">Payout $/1K views*
            <input required type="number" step="any" min={0} value={form.payout_per_1k_usd} onChange={set("payout_per_1k_usd")} className={inputCls} />
          </label>
          <label className="text-sm">Budget remaining ($)
            <input type="number" step="any" min={0} value={form.budget_remaining_usd} onChange={set("budget_remaining_usd")} className={inputCls} />
          </label>
          <label className="text-sm">Min seconds
            <input type="number" min={1} value={form.min_seconds} onChange={set("min_seconds")} className={inputCls} />
          </label>
          <label className="text-sm">Max seconds
            <input type="number" min={1} value={form.max_seconds} onChange={set("max_seconds")} className={inputCls} />
          </label>
          <label className="text-sm md:col-span-2">Requirements
            <textarea rows={3} value={form.requirements} onChange={set("requirements")} className={inputCls} />
          </label>
          <label className="text-sm md:col-span-2">Caption template
            <textarea rows={2} value={form.caption_template} onChange={set("caption_template")} className={inputCls} />
          </label>
          <label className="text-sm">Hashtags (comma separated)
            <input value={form.hashtags} onChange={set("hashtags")} placeholder="#BlizzardPartner, #DiabloV" className={inputCls} />
          </label>
          <div className="grid gap-3 md:grid-cols-2 md:col-span-2">
            <label className="text-sm">Brief URL
              <input value={form.brief_url} onChange={set("brief_url")} className={inputCls} />
            </label>
            <label className="text-sm">Campaign URL
              <input value={form.campaign_url} onChange={set("campaign_url")} className={inputCls} />
            </label>
          </div>
          <button type="submit" disabled={adding} className={`${btnPrimary} md:col-span-2`}>
            {adding ? "Adding…" : "Add campaign"}
          </button>
        </form>
      )}

      <div className="grid gap-4">
        {campaigns.length === 0 && (
          <p className="text-slate-500 text-sm">No campaigns yet — scout-add the first one above.</p>
        )}
        {campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} onSaved={(m) => { setMsg(m); reload(); }} />
        ))}
      </div>
    </div>
  );
}
