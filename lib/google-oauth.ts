/** Shared Google OAuth helpers — kept out of route files because Next.js
 *  route modules may only export HTTP method handlers. */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

/**
 * The redirect URI sent to Google. When GOOGLE_OAUTH_REDIRECT_URI is set
 * (recommended: the canonical production URL), it is used on EVERY host, so
 * only one URI ever needs to be registered in Google Cloud Console —
 * no more "redirect_uri mismatch" when the app is opened via a different
 * Vercel alias/preview URL.
 */
export function callbackUrl(req: Request): string {
  const fixed = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (fixed) return fixed;
  return (
    new URL("/api/oauth/google/callback", req.url).origin +
    "/api/oauth/google/callback"
  );
}

/**
 * If a canonical redirect URI is configured and this request came in on a
 * different host, returns the canonical /api/oauth/google/start URL so the
 * whole dance (state cookie, session, callback) happens on one host.
 * Returns null when already canonical or no override is set.
 */
export function canonicalOAuthStartUrl(req: Request): string | null {
  const fixed = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!fixed) return null;
  let wantOrigin: string;
  try {
    wantOrigin = new URL(fixed).origin;
  } catch {
    return null;
  }
  const reqOrigin = new URL(req.url).origin;
  if (reqOrigin === wantOrigin) return null;
  return `${wantOrigin}/api/oauth/google/start`;
}
