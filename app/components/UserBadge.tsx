"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";

/** Sidebar footer: signed-in email + sign out. Hidden when signed out. */
export default function UserBadge() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let supabase: ReturnType<typeof getBrowserSupabase> | null = null;
    try {
      supabase = getBrowserSupabase();
    } catch {
      return;
    }
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!email) return null;

  return (
    <div className="mt-auto pt-4 border-t border-line grid gap-2">
      <p className="text-xs text-slate-400 truncate" title={email}>{email}</p>
      <button
        className="text-xs text-slate-400 hover:text-red-300 text-left"
        onClick={async () => {
          await getBrowserSupabase().auth.signOut();
          router.push("/login");
          router.refresh();
        }}
      >
        Sign out
      </button>
    </div>
  );
}
