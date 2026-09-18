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

/** OIDC nonce — Whop requires `nonce` when the `openid` scope is requested. */
export function oauthNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Resolves the Whop OAuth *app* credentials (client ID + secret).
 *
 * Precedence:
 *   1. Vercel env vars WHOP_OAUTH_CLIENT_ID / WHOP_OAUTH_CLIENT_SECRET.
 *   2. Owner-pasted credentials stored encrypted in the connections table
 *      (service=whop, method=oauth-app) via the Admin panel — so the owner
 *      can finish setup from the UI without touching Vercel.
 *
 * Returns null when neither is present. Never logs the secret.
 */
export async function getWhopOAuthAppConfig(): Promise<{
  clientId: string;
  clientSecret: string;
  source: "env" | "admin";
} | null> {
  const envId = process.env.WHOP_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.WHOP_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: "env" };
  }
  try {
    const { getSupabase, isConfigured } = await import("./supabase");
    const { decryptSecret } = await import("./crypto");
    const sb = getSupabase();
    if (!sb || !isConfigured()) return null;
    const { data } = await sb
      .from("connections")
      .select("secret_enc")
      .eq("service", "whop")
      .eq("method", "oauth-app")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.secret_enc) return null;
    const s = decryptSecret<{ client_id?: string; client_secret?: string }>(
      data.secret_enc as string
    );
    if (s.client_id && s.client_secret) {
      return {
        clientId: s.client_id,
        clientSecret: s.client_secret,
        source: "admin",
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}
