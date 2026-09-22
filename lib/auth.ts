import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

/**
 * Returns the signed-in Supabase Auth user for a route handler, or null.
 * Reads the session from cookies (set by the login page / middleware refresh).
 * Read-only: never writes cookies here.
 */
export async function getSessionUser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const jar = cookies();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: () => {},
    },
  });
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

export type RouteIdentity =
  | { userId: string }
  | { error: NextResponse };

/**
 * Identity for API routes.
 * - Worker calls: valid x-worker-secret header + ?user_id=<uuid> query param.
 *   (The worker iterates users; see /api/worker/users.)
 * - Browser/app calls: the signed-in user's session. 401 when signed out.
 */
export async function getRouteUserId(req: Request): Promise<RouteIdentity> {
  const workerSecret = process.env.WORKER_SECRET;
  if (
    workerSecret &&
    req.headers.get("x-worker-secret") === workerSecret
  ) {
    const uid = new URL(req.url).searchParams.get("user_id");
    if (!uid) {
      return {
        error: NextResponse.json(
          { error: "user_id query param is required for worker calls." },
          { status: 400 }
        ),
      };
    }
    return { userId: uid };
  }
  const user = await getSessionUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    };
  }
  return { userId: user.id };
}
