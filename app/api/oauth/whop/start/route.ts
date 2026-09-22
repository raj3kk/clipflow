import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  WHOP_AUTHORIZE_URL,
  WHOP_SCOPES,
  whopCallbackUrl,
  pkceVerifier,
  pkceChallenge,
  oauthState,
  oauthNonce,
  getWhopOAuthAppConfig,
} from "@/lib/whop-oauth";

/**
 * Starts the official "Login with Whop" OAuth dance (PKCE).
 * Redirects the user's browser to Whop's consent screen.
 * Works when the Whop OAuth app is configured via Vercel env vars or
 * pasted in the Admin panel (see /api/admin/whop-oauth).
 */
export async function GET(req: Request) {
  const appCfg = await getWhopOAuthAppConfig();
  if (!appCfg) {
    return NextResponse.json(
      { error: "Whop OAuth is not configured on the server yet." },
      { status: 503 }
    );
  }
  const clientId = appCfg.clientId;
  // Only signed-in users can start OAuth (the connection binds to them).
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(
      new URL("/login?next=/connections", req.url).toString()
    );
  }
  const state = oauthState();
  const verifier = pkceVerifier();
  const nonce = oauthNonce();
  const redirectUri = whopCallbackUrl(req);
  const url = new URL(WHOP_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", WHOP_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");

  const res = NextResponse.redirect(url.toString());
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("cf_whop_oauth_state", state, cookieOpts);
  res.cookies.set("cf_whop_pkce_verifier", verifier, cookieOpts);
  res.cookies.set("cf_whop_oauth_nonce", nonce, cookieOpts);
  return res;
}
