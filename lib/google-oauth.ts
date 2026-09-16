/** Shared Google OAuth helpers — kept out of route files because Next.js
 *  route modules may only export HTTP method handlers. */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

export function callbackUrl(req: Request): string {
  return (
    new URL("/api/oauth/google/callback", req.url).origin +
    "/api/oauth/google/callback"
  );
}
