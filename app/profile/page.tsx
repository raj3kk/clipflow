"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { useApi } from "../components/useApi";
import { cardCls, btnDanger, fmtDate, fmtDT } from "../components/ui";
import { IconUser, IconLogout, IconPhone, IconCampaign, IconCheck } from "../components/icons";
import { getMode } from "../components/mode";

interface Me {
  email: string | null;
  id: string | null;
  createdAt: string | null;
  lastSignIn: string | null;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-200 py-2.5 last:border-0">
      <span className="text-xs uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`text-sm text-slate-900 text-right break-all ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [mode] = useState(getMode());
  const devices = useApi<{ devices: { id: string }[] }>("/api/devices");
  const stats = useApi<{ stats: { posts_today?: number; submitted_today?: number } }>("/api/stats");

  useEffect(() => {
    let s: ReturnType<typeof getBrowserSupabase> | null = null;
    try {
      s = getBrowserSupabase();
    } catch {
      return;
    }
    s.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (!u) {
        router.push("/login");
        return;
      }
      setMe({
        email: u.email ?? null,
        id: u.id ?? null,
        createdAt: u.created_at ?? null,
        lastSignIn: u.last_sign_in_at ?? null,
      });
    });
  }, [router]);

  const initial = (me?.email?.[0] ?? "?").toUpperCase();
  const deviceCount = devices.data?.devices?.length ?? 0;

  const signOut = async () => {
    try {
      await getBrowserSupabase().auth.signOut();
    } catch {}
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="font-display text-2xl font-bold magic-text">Profile</h1>
        <p className="text-sm text-slate-600">Tumhari account info aur automation stats</p>
      </div>

      {/* identity card */}
      <div className={`${cardCls} glass-hover relative overflow-hidden`}>
        <div className="flex items-center gap-4">
          <span
            className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-emerald-600 text-2xl font-bold text-white shadow-sm"
          >
            {me ? initial : <IconUser className="h-7 w-7" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-slate-900">
              {me?.email ?? "Loading…"}
            </p>
            <p className="flex items-center gap-1.5 text-xs text-emerald-700">
              <IconCheck className="h-3.5 w-3.5" /> signed in ·{" "}
              {mode === "v2" ? "v2 phone mode" : "v1 server mode"}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <InfoRow label="Email" value={me?.email ?? "—"} />
          <InfoRow label="User ID" value={me?.id ? `${me.id.slice(0, 8)}…${me.id.slice(-4)}` : "—"} mono />
          <InfoRow label="Member since" value={fmtDate(me?.createdAt)} />
          <InfoRow label="Last sign in" value={fmtDT(me?.lastSignIn)} />
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className={`${cardCls} glass-hover`}>
          <div className="flex items-center gap-2 text-slate-600">
            <IconPhone className="h-4 w-4" />
            <span className="text-xs uppercase tracking-wider">Devices (v2)</span>
          </div>
          <p className="mt-2 font-display text-3xl font-bold magic-text stat-glow">
            {devices.loading ? "…" : deviceCount}
          </p>
        </div>
        <div className={`${cardCls} glass-hover`}>
          <div className="flex items-center gap-2 text-slate-600">
            <IconCampaign className="h-4 w-4" />
            <span className="text-xs uppercase tracking-wider">Posts today (v1)</span>
          </div>
          <p className="mt-2 font-display text-3xl font-bold magic-text stat-glow">
            {stats.loading ? "…" : (stats.data?.stats?.posts_today ?? 0)}
          </p>
        </div>
        <div className={`${cardCls} glass-hover col-span-2 sm:col-span-1`}>
          <div className="flex items-center gap-2 text-slate-600">
            <IconCheck className="h-4 w-4" />
            <span className="text-xs uppercase tracking-wider">Submitted today</span>
          </div>
          <p className="mt-2 font-display text-3xl font-bold magic-text stat-glow">
            {stats.loading ? "…" : (stats.data?.stats?.submitted_today ?? 0)}
          </p>
        </div>
      </div>

      {/* actions */}
      <div className={cardCls}>
        <p className="mb-3 text-sm font-semibold text-slate-800">Session</p>
        <button onClick={signOut} className={`${btnDanger} flex items-center gap-2 px-4 py-2.5`}>
          <IconLogout className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );
}
