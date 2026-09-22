"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { inputCls, btnPrimary } from "../components/ui";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setMsg(error.message);
      } else if (data.session) {
        // Email confirmation disabled (or auto-confirmed): signed in already.
        router.push("/");
        router.refresh();
      } else {
        // Email confirmation enabled: ask the user to click the link.
        setDone(true);
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
            <img src="/brand-cf.webp" alt="ClipFlow" className="h-9 w-9 rounded-xl bg-white object-contain shadow-sm" />
            <div className="text-xl font-bold text-accent">ClipFlow</div>
          </div>
          <p className="text-sm text-slate-600 mt-1">Create your clipping workspace.</p>
        </div>
        {done ? (
          <p className="text-sm text-emerald-700">
            ✅ Account created — check <span className="font-medium">{email}</span> for the
            confirmation link, then sign in.
          </p>
        ) : (
          <>
            {msg && <p className="text-sm text-red-700">{msg}</p>}
            <label className="grid gap-1 text-sm">
              Email
              <input className={inputCls} type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label className="grid gap-1 text-sm">
              Password
              <input className={inputCls} type="password" required minLength={6} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" />
            </label>
            <button className={btnPrimary} disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </>
        )}
        <p className="text-sm text-slate-600">
          Already have an account? <Link href="/login" className="text-accent underline">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
