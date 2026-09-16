import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase Auth session cookie on every request and protects
 * app pages: signed-out visitors are sent to /login; signed-in users hitting
 * /login or /signup are sent home. API routes enforce their own auth
 * (session 401 or x-worker-secret), so they are left alone here.
 */
export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let res = NextResponse.next({ request: { headers: req.headers } });

  let user = null;
  if (url && anon) {
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          cookiesToSet.forEach(
            ({ name, value, options }: { name: string; value: string; options?: Record<string, unknown> }) =>
              res.cookies.set(name, value, options)
          );
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
  }

  const path = req.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  const isPublicPage = path === "/login" || path === "/signup";

  if (!isApi && !user && !isPublicPage) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }
  if (!isApi && user && isPublicPage) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
