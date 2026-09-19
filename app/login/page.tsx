"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { inputCls, btnPrimary } from "../components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMsg(error.message);
      } else {
        router.push(params.get("next") || "/");
        router.refresh();
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <form onSubmit={onSubmit} className="w-full max-w-sm grid gap-4 rounded-2xl border border-line bg-panel p-8">
        <div>
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="ClipFlow" className="h-9 w-9 rounded-xl bg-white object-contain shadow-sm" />
            <div className="text-xl font-bold text-accent">ClipFlow</div>
          </div>
          <p className="text-sm text-slate-600 mt-1">Sign in to your clipping workspace.</p>
        </div>
        {msg && <p className="text-sm text-red-700">{msg}</p>}
        <label className="grid gap-1 text-sm">
          Email
          <input className={inputCls} type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="grid gap-1 text-sm">
          Password
          <input className={inputCls} type="password" required value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
        <button className={btnPrimary} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-sm text-slate-600">
          New here? <Link href="/signup" className="text-accent underline">Create an account</Link>
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="text-slate-600">Loading…</p>}>
      <LoginForm />
    </Suspense>
  );
}
