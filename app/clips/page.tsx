"use client";

import { useEffect, useState } from "react";
import { Clip, Campaign, ClipStatus } from "@/lib/types";

const STATUS_COLOR: Record<ClipStatus, string> = {
  queued: "bg-slate-700 text-slate-200",
  rendering: "bg-blue-900 text-blue-200",
  preview: "bg-gold/20 text-gold",
  approved: "bg-emerald-900 text-emerald-200",
  posting: "bg-blue-900 text-blue-200",
  posted: "bg-cyan-900 text-cyan-200",
  submitted: "bg-emerald-900 text-emerald-200",
  failed: "bg-red-900 text-red-200",
};

export default function ClipsPage() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ campaign_id: "", source_url: "", start_sec: "", end_sec: "", hook_text: "" });
  const [msg, setMsg] = useState("");

  const load = () => {
    fetch("/api/clips").then((r) => r.json()).then((d) => setClips(d.clips ?? []));
    fetch("/api/campaigns").then((r) => r.json()).then((d) => {
      setCampaigns(d.campaigns ?? []);
      if (d.campaigns?.length && !form.campaign_id) {
        setForm((f) => ({ ...f, campaign_id: d.campaigns[0].id }));
      }
    }).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const createJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("Queue ho raha hai…");
    const res = await fetch("/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_id: form.campaign_id,
        source_url: form.source_url,
        start_sec: Number(form.start_sec),
        end_sec: Number(form.end_sec),
        hook_text: form.hook_text || null,
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? "Job queued! Server pe render shuru hoga." : `Error: ${d.error}`);
    if (res.ok) { setForm({ ...form, source_url: "", start_sec: "", end_sec: "", hook_text: "" }); load(); }
  };

  const act = async (id: string, action: "approve" | "post") => {
    setMsg("Kaam ho raha hai…");
    const res = await fetch(`/api/clips/${id}/${action}`, { method: "POST" });
    const d = await res.json();
    if (!res.ok) setMsg(`Error: ${d.error}`);
    else if (d.blocked) setMsg(`Blocked: ${d.reason}`);
    else setMsg(action === "approve" ? "Approved!" : "Posting ke liye bhej diya.");
    load();
  };

  if (loading) return <p className="text-slate-400">Loading clips…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Clips</h1>
      <p className="text-slate-400 text-sm mb-6">Render queue → preview → approve → post</p>
      {msg && <div className="mb-4 rounded-lg border border-line bg-panel p-3 text-sm">{msg}</div>}

      <form onSubmit={createJob} className="rounded-xl border border-line bg-panel p-5 mb-8 grid gap-3 md:grid-cols-2">
        <h2 className="font-semibold md:col-span-2">Naya render job</h2>
        <label className="text-sm">Campaign
          <select value={form.campaign_id} onChange={(e) => setForm({ ...form, campaign_id: e.target.value })}
            className="mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Hook text
          <input value={form.hook_text} onChange={(e) => setForm({ ...form, hook_text: e.target.value })}
            placeholder="Joe Rogan ditched Google for Perplexity"
            className="mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm" />
        </label>
        <label className="text-sm md:col-span-2">Source video URL
          <input value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} required
            placeholder="https://www.youtube.com/watch?v=…"
            className="mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm" />
        </label>
        <label className="text-sm">Start (seconds)
          <input type="number" value={form.start_sec} onChange={(e) => setForm({ ...form, start_sec: e.target.value })} required min={0}
            className="mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm" />
        </label>
        <label className="text-sm">End (seconds, 15–60s clip)
          <input type="number" value={form.end_sec} onChange={(e) => setForm({ ...form, end_sec: e.target.value })} required min={0}
            className="mt-1 w-full rounded-lg bg-ink border border-line p-2 text-sm" />
        </label>
        <button type="submit" className="md:col-span-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink">
          Queue render job
        </button>
      </form>

      <div className="grid gap-4">
        {clips.length === 0 && <p className="text-slate-500 text-sm">Abhi koi clip nahi hai. Upar se pehla job banao.</p>}
        {clips.map((c) => (
          <div key={c.id} className="rounded-xl border border-line bg-panel p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold">{c.campaign_name ?? c.campaign_id}</div>
                <div className="text-xs text-slate-400">{c.start_sec}s → {c.end_sec}s · {c.end_sec - c.start_sec}s</div>
                {c.error && <div className="text-xs text-red-300 mt-1">{c.error}</div>}
              </div>
              <span className={`rounded px-2 py-1 text-xs ${STATUS_COLOR[c.status]}`}>{c.status}</span>
            </div>
            {c.preview_urls && c.preview_urls.length > 0 && (
              <div className="flex gap-2 mt-3">
                {c.preview_urls.slice(0, 4).map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={u} alt={`preview ${i}`} className="h-32 rounded-lg border border-line object-cover" />
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              {c.status === "preview" && (
                <button onClick={() => act(c.id, "approve")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold">Approve</button>
              )}
              {c.status === "approved" && (
                <button onClick={() => act(c.id, "post")} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-ink">Post to Instagram</button>
              )}
              {c.instagram_url && (
                <a href={c.instagram_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line px-3 py-1.5 text-xs text-accent">View Reel ↗</a>
              )}
              {c.video_url && (
                <a href={c.video_url} target="_blank" rel="noreferrer" className="rounded-lg border border-line px-3 py-1.5 text-xs text-slate-300">Video ↗</a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
