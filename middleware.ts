import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/* Public (no-auth, no-app-shell) pages: landing + legal + auth forms.
   App pages (devices, live, campaigns, ...) stay behind sign-in via middleware. */
const PUBLIC_PAGES = ["/login", "/signup", "/", "/guide", "/terms", "/privacy"];
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
  const isPublicPage = PUBLIC_PAGES.includes(path);

  if (!isApi && !user && !isPublicPage) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }
  // signed-in users land straight into the app (V2 home = Devices)
  if (!isApi && user && (path === "/" || path === "/login" || path === "/signup")) {
    return NextResponse.redirect(new URL("/devices", req.url));
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
