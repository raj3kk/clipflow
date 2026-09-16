import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSessionUser } from "@/lib/auth";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

export function callbackUrl(req: Request): string {
  return new URL("/api/oauth/google/callback", req.url).origin + "/api/oauth/google/callback";
}

/**
 * Starts the real Google OAuth dance for Gmail access.
 * Redirects the user's browser to Google's consent screen.
 * Only works when GOOGLE_OAUTH_CLIENT_ID/SECRET are configured (see /api/oauth/google/status).
 */
export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Google OAuth is not configured on the server yet." },
      { status: 503 }
    );
  }
  // Only signed-in users can start OAuth (the connection binds to them).
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/connections", req.url).toString());
  }
  const state = randomBytes(16).toString("hex");
  const redirectUri = callbackUrl(req);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  // offline => refresh_token; prompt=consent => refresh_token every time.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set("cf_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
