"use client";

import { useState } from "react";
import { useApi } from "../components/useApi";
import SetupBanner from "../components/SetupBanner";
import StatusPill from "@/lib/status-pill";
import { Msg, btnGhost, btnPrimary, cardCls, countdown, fmtDT, inputCls } from "../components/ui";
import { PostRow, PostSubmission, isScheduled, postCampaignName, postSubmission } from "../components/models";
import { Settings } from "@/lib/types";

interface PostsResp {
  posts: PostRow[];
  configured: boolean;
  error?: string;
}
interface SettingsResp {
  settings: Settings;
  configured: boolean;
  error?: string;
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return isNaN(ms) ? null : Math.round(ms / 60000);
}

function PostCard({ p, sub }: { p: PostRow; sub: PostSubmission | null }) {
  const mins = minutesBetween(p.posted_at, sub?.submitted_at ?? null);
  const frames = p.verify_detail?.frames ?? [];
  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-semibold text-sm">{postCampaignName(p)}</div>
          {p.instagram_url ? (
            <a href={p.instagram_url} target="_blank" rel="noreferrer" className="text-xs text-accent underline break-all">
              {p.instagram_url}
            </a>
          ) : (
            <div className="text-xs text-slate-600">
              Scheduled {p.posted_at ? `· ${countdown(p.posted_at)}` : ""}
            </div>
          )}
          <div className="text-xs text-slate-500 mt-1">
            Posted {fmtDT(p.posted_at)} · Platform: {p.platform ?? "instagram"}
          </div>
        </div>
        <div className="flex gap-1 flex-wrap justify-end shrink-0">
          {p.verify_status && <StatusPill status={p.verify_status} />}
          {sub?.whop_status ? (
            <StatusPill status={sub.whop_status} />
          ) : (
            <span className="text-xs text-slate-600">no Whop submission</span>
          )}
        </div>
      </div>

      {p.verify_detail?.detail && (
        <p className="text-xs text-slate-600 mt-2">{p.verify_detail.detail}</p>
      )}
      {frames.length > 0 && (
        <div className="flex gap-2 mt-2 overflow-x-auto">
          {frames.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt={`verify frame ${i}`} className="h-24 rounded-lg border border-line object-cover" />
          ))}
        </div>
      )}

      <div className="mt-3 text-xs text-slate-600 border-t border-line pt-3 flex flex-wrap gap-x-6 gap-y-1">
        <span>
          Whop submitted: <span className="text-slate-700">{fmtDT(sub?.submitted_at)}</span>
        </span>
        <span>
          Post → submit:{" "}
          {mins == null ? (
            <span className="text-slate-500">—</span>
          ) : mins > 20 ? (
            <span className="text-red-700 font-semibold">{mins} min ⚠ over 20-min rule</span>
          ) : (
            <span className="text-emerald-700">{mins} min ✓</span>
          )}
        </span>
      </div>
    </div>
  );
}

export default function PostSubmitPage() {
  const postsApi = useApi<PostsResp>("/api/posts");
  const settingsApi = useApi<SettingsResp>("/api/settings");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({
    instagram_url: "",
    posted_at: "",
    clip_id: "",
    campaign_id: "",
    platform: "instagram",
  });

  const loading = postsApi.loading || settingsApi.loading;
  if (loading) return <p className="text-slate-600">Loading posts…</p>;

  const err = postsApi.error ?? settingsApi.error;
  if (err) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Post &amp; Submit</h1>
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-700">
          API error: {err}
        </div>
      </div>
    );
  }

  const posts = postsApi.data?.posts ?? [];
  const spacingH = Number(settingsApi.data?.settings?.spacing_hours ?? 4);
  const maxPerDay = Number(settingsApi.data?.settings?.daily_target ?? 4);

  // Schedule queue: rows created at schedule time; instagram_url empty until
  // the worker actually posts. posted_at holds the scheduled time.
  const scheduled = posts
    .filter((p) => isScheduled(p) && p.posted_at)
    .sort((a, b) => +new Date(a.posted_at!) - +new Date(b.posted_at!));

  const violations: string[] = [];
  for (let i = 1; i < scheduled.length; i++) {
    const gap =
      (new Date(scheduled[i].posted_at!).getTime() -
        new Date(scheduled[i - 1].posted_at!).getTime()) /
      3600000;
    if (gap < spacingH) {
      violations.push(
        `Gap of ${gap.toFixed(1)}h between two scheduled posts is under the ${spacingH}h minimum.`
      );
    }
  }
  const perDay = new Map<string, number>();
  scheduled.forEach((p) => {
    const day = new Date(p.posted_at!).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  });
  perDay.forEach((n, day) => {
    if (n > maxPerDay) violations.push(`${day}: ${n} posts scheduled — over the ${maxPerDay}/day cap.`);
  });

  const recordManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("Recording…");
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instagram_url: manual.instagram_url,
        posted_at: manual.posted_at || undefined,
        clip_id: manual.clip_id || undefined,
        campaign_id: manual.campaign_id || undefined,
        platform: manual.platform || "instagram",
      }),
    });
    const d = await res.json();
    setBusy(false);
    if (res.ok) {
      setMsg("Manual post recorded — spacing stays correct for the worker.");
      setManual({ instagram_url: "", posted_at: "", clip_id: "", campaign_id: "", platform: "instagram" });
      postsApi.reload();
    } else {
      setMsg(`Error: ${d.error ?? res.status}`);
    }
  };

  const set = (k: keyof typeof manual) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setManual({ ...manual, [k]: e.target.value });

  const done = posts.filter((p) => !isScheduled(p));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Post &amp; Submit</h1>
      <p className="text-slate-600 text-sm mb-6">
        Schedule queue (≥{spacingH}h spacing · max {maxPerDay}/day) · manual posts · verification · Whop submissions
      </p>

      {postsApi.data && !postsApi.data.configured && <SetupBanner />}
      <Msg msg={msg} />

      <div className={`${cardCls} mb-8`}>
        <h2 className="font-semibold mb-3">Schedule queue</h2>
        {violations.map((v, i) => (
          <div key={i} className="mb-2 rounded-lg border border-red-300 bg-red-50 p-2.5 text-xs text-red-700">
            {v}
          </div>
        ))}
        {scheduled.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing scheduled right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-line">
                <th className="py-2 pr-3">Campaign</th>
                <th className="py-2 pr-3">Scheduled for</th>
                <th className="py-2">Countdown</th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">{postCampaignName(p)}</td>
                  <td className="py-2 pr-3 text-slate-700">{fmtDT(p.posted_at)}</td>
                  <td className="py-2 text-accent">{countdown(p.posted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form onSubmit={recordManual} className={`${cardCls} mb-8 grid gap-3 md:grid-cols-2`}>
        <h2 className="font-semibold md:col-span-2">Record manual post</h2>
        <p className="text-xs text-slate-500 md:col-span-2">
          For posts made outside the worker — keeps spacing and daily counts correct.
        </p>
        <label className="text-sm">Instagram URL*
          <input required value={manual.instagram_url} onChange={set("instagram_url")} placeholder="https://www.instagram.com/reel/…" className={inputCls} />
        </label>
        <label className="text-sm">Posted at
          <input type="datetime-local" value={manual.posted_at} onChange={set("posted_at")} className={inputCls} />
        </label>
        <label className="text-sm">Clip ID (optional)
          <input value={manual.clip_id} onChange={set("clip_id")} className={inputCls} />
        </label>
        <label className="text-sm">Campaign ID (optional)
          <input value={manual.campaign_id} onChange={set("campaign_id")} className={inputCls} />
        </label>
        <label className="text-sm">Platform
          <select value={manual.platform} onChange={set("platform")} className={inputCls}>
            <option value="instagram">instagram</option>
            <option value="tiktok">tiktok</option>
            <option value="x">x</option>
            <option value="youtube">youtube</option>
          </select>
        </label>
        <div className="md:col-span-2">
          <button type="submit" disabled={busy} className={btnPrimary}>Record post</button>
        </div>
      </form>

      <h2 className="font-semibold mb-3">Posts</h2>
      <div className="grid gap-4">
        {done.length === 0 && (
          <p className="text-slate-500 text-sm">Abhi koi post nahi hua.</p>
        )}
        {done.map((p) => (
          <PostCard key={p.id} p={p} sub={postSubmission(p)} />
        ))}
      </div>

      <div className="mt-8 flex gap-3">
        <a href="/clips" className={btnGhost}>← Clips</a>
      </div>
    </div>
  );
}
