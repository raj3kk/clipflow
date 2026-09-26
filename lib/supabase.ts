import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let tried = false;

export function isConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function getSupabase(): SupabaseClient | null {
  if (!isConfigured()) return null;
  if (!client && !tried) {
    tried = true;
    // ROOT FIX (2026-09-26): Next.js GET Route Handlers me fetch() ka Data Cache
    // lagta hai — force-dynamic hone ke bawajood supabase-js ke SELECT/PATCH
    // stale cached responses de rahe the (production me prove hua: 30+ min purana
    // pending_step wapas mil raha tha, clear kabhi DB tak pahunch hi nahi raha tha).
    // Realtime DB client ke liye cache kabhi sahi nahi — explicit no-store.
    const noStoreFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetch(input, { ...init, cache: "no-store" });
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { global: { fetch: noStoreFetch as typeof fetch } }
    );
  }
  return client;
}

/** Read-only client for browser components (anon key). Falls back to null. */
export function isPublicConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
