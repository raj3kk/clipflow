/** Shared Whop OAuth helpers — kept out of route files because Next.js
 *  route modules may only export HTTP method handlers.
 *
 *  Uses Whop's current OAuth flow (PKCE):
 *    authorize: https://api.whop.com/oauth/authorize
 *    token:     https://api.whop.com/oauth/token
 *    userinfo:  https://api.whop.com/oauth/userinfo
 */
import { createHash, randomBytes } from "crypto";

export const WHOP_AUTHORIZE_URL = "https://api.whop.com/oauth/authorize";
export const WHOP_TOKEN_URL = "https://api.whop.com/oauth/token";
export const WHOP_USERINFO_URL = "https://api.whop.com/oauth/userinfo";

export const WHOP_SCOPES = ["openid", "profile", "email"].join(" ");

/**
 * The redirect URI sent to Whop. When WHOP_OAUTH_REDIRECT_URI is set
 * (recommended: the canonical production URL), it is used on EVERY host, so
 * only one URI ever needs to be registered in the Whop dashboard.
 */
export function whopCallbackUrl(req: Request): string {
  const fixed = process.env.WHOP_OAUTH_REDIRECT_URI?.trim();
  if (fixed) return fixed;
  return (
    new URL("/api/oauth/whop/callback", req.url).origin +
    "/api/oauth/whop/callback"
  );
}

/** PKCE code_verifier (43-128 chars, base64url). */
export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE code_challenge = BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function oauthState(): string {
  return randomBytes(16).toString("hex");
}
