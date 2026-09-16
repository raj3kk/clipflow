"use client";

import { useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import { Msg, btnPrimary, btnGhost, cardCls, inputCls } from "../components/ui";
import { Clip, Campaign, ClipStatus } from "@/lib/types";

const STATUS_COLOR: Record<ClipStatus, string> = {
  queued: "bg-slate-700 text-slate-200",
  rendering: "bg-blue-900 text-blue-200",
  preview: "bg-gold/20 text-gold",
  approved: "bg-emerald-900 text-emerald-200",
  scheduled: "bg-violet-900 text-violet-200",
  posting: "bg-blue-900 text-blue-200",
  posted: "bg-cyan-900 text-cyan-200",
  submitted: "bg-emerald-900 text-emerald-200",
  failed: "bg-red-900 text-red-200",
};

interface ClipsResp {
  clips: (Clip & { campaigns?: { name: string } })[];
  configured: boolean;
  error?: string;
}
interface CampaignsResp {
  campaigns: Campaign[];
  configured: boolean;
  error?: string;
}

const EMPTY = { campaign_id: "", source_url: "", start_sec: "", end_sec: "", hook_text: "", caption: "" };

export default function ClipsPage() {
  const clipsApi = useApi<ClipsResp>("/api/clips");
  const campsApi = useApi<CampaignsResp>("/api/campaigns");
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const loading = clipsApi.loading || campsApi.loading;
  if (loading) return <p className="text-slate-400">Loading clips…</p>;

  const err = clipsApi.error ?? campsApi.error;
  if (err) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Clips</h1>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          API error: {err}
        </div>
      </div>
    );
  }

  const clips = clipsApi.data?.clips ?? [];
  const campaigns = campsApi.data?.campaigns ?? [];
  const campaignId = form.campaign_id || campaigns[0]?.id || "";

  const createJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("Queue ho raha hai…");
    const res = await fetch("/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_id: campaignId,
        source_url: form.source_url,
        start_sec: Number(form.start_sec),
        end_sec: Number(form.end_sec),
        hook_text: form.hook_text || null,
        caption: form.caption || null,
      }),
    });
    const d = await res.json();
    setBusy(false);
    if (res.ok) {
      setMsg("Job queued! Worker render shuru karega.");
      setForm(EMPTY);
      clipsApi.reload();
    } else {
      setMsg(`Error: ${d.error ?? res.status}`);
    }
  };

  const act = async (id: string, action: "approve" | "post") => {
    setBusy(true);
    setMsg("Kaam ho raha hai…");
    const res = await fetch(`/api/clips/${id}/${action}`, { method: "POST" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) setMsg(`Error: ${d.error ?? res.status}`);
    else if (d.blocked) setMsg(`Blocked: ${d.reason}`);
    else if (action === "approve") setMsg("Approved!");
    else setMsg(`Post scheduled${d.post?.scheduled_for ? ` for ${d.post.scheduled_for}` : ""}. Worker real posting karega.`);
    clipsApi.reload();
  };

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Clips</h1>
      <p className="text-slate-400 text-sm mb-6">
        Render queue → preview → approve → schedule post (worker posts)
      </p>

      {clipsApi.data && !clipsApi.data.configured && <SetupBanner />}
      <Msg msg={msg} />

      <form onSubmit={createJob} className={`${cardCls} mb-8 grid gap-3 md:grid-cols-2`}>
        <h2 className="font-semibold md:col-span-2">Naya render job</h2>
        <label className="text-sm">Campaign
          <select value={campaignId} onChange={set("campaign_id")} className={inputCls}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">Hook text
          <input value={form.hook_text} onChange={set("hook_text")}
            placeholder="Joe Rogan ditched Google for Perplexity"
            className={inputCls} />
        </label>
        <label className="text-sm md:col-span-2">Source video URL
          <input value={form.source_url} onChange={set("source_url")} required
            placeholder="https://www.youtube.com/watch?v=…"
            className={inputCls} />
        </label>
        <label className="text-sm">Start (seconds)
          <input type="number" value={form.start_sec} onChange={set("start_sec")} required min={0}
            className={inputCls} />
        </label>
        <label className="text-sm">End (seconds, 15–60s clip)
          <input type="number" value={form.end_sec} onChange={set("end_sec")} required min={0}
            className={inputCls} />
        </label>
        <label className="text-sm md:col-span-2">Caption (optional)
          <textarea rows={2} value={form.caption} onChange={set("caption")}
            placeholder="Caption for the Reel…"
            className={inputCls} />
        </label>
        <button type="submit" disabled={busy} className={`${btnPrimary} md:col-span-2`}>
          Queue render job
        </button>
      </form>

      <div className="grid gap-4">
        {clips.length === 0 && (
          <p className="text-slate-500 text-sm">Abhi koi clip nahi hai. Upar se pehla job banao.</p>
        )}
        {clips.map((c) => (
          <div key={c.id} className={cardCls}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold">{c.campaign_name ?? c.campaigns?.name ?? c.campaign_id}</div>
                <div className="text-xs text-slate-400">
                  {c.start_sec}s → {c.end_sec}s · {c.end_sec - c.start_sec}s
                  {c.hook_text ? ` · “${c.hook_text}”` : ""}
                </div>
                {c.error && <div className="text-xs text-red-300 mt-1">{c.error}</div>}
              </div>
              <span className={`rounded px-2 py-1 text-xs ${STATUS_COLOR[c.status]}`}>{c.status}</span>
            </div>
            {c.preview_urls && c.preview_urls.length > 0 && (
              <div className="flex gap-2 mt-3 overflow-x-auto">
                {c.preview_urls.slice(0, 4).map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={u} alt={`preview ${i}`} className="h-32 rounded-lg border border-line object-cover" />
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2 flex-wrap">
              {c.status === "preview" && (
                <button disabled={busy} onClick={() => act(c.id, "approve")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50">
                  Approve
                </button>
              )}
              {c.status === "approved" && (
                <button disabled={busy} onClick={() => act(c.id, "post")} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-ink hover:opacity-90 disabled:opacity-50">
                  Schedule post
                </button>
              )}
              {c.instagram_url && (
                <a href={c.instagram_url} target="_blank" rel="noreferrer" className={btnGhost}>View Reel ↗</a>
              )}
              {c.video_url && (
                <a href={c.video_url} target="_blank" rel="noreferrer" className={btnGhost}>Video ↗</a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
