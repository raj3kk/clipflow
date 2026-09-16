"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client (anon key). Used by login/signup pages and
 * any client component that needs the user's session. Session is stored in
 * cookies, so the user stays signed in across visits (auto-refresh).
 */
export function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase is not configured.");
  return createBrowserClient(url, anon);
}
