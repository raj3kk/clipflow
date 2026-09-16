import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { callbackUrl } from "../start/route";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * Google OAuth callback: exchanges the code for tokens, fetches the Gmail
 * address, and stores an encrypted gmail/oauth connection the VM worker can
 * use (it refreshes access tokens itself from the stored refresh_token).
 * Never logs or returns any token.
 */
export async function GET(req: Request) {
  const appOrigin = new URL(req.url).origin;
  const fail = (msg: string) =>
    NextResponse.redirect(
      `${appOrigin}/connections?oauth=error&detail=${encodeURIComponent(msg)}`
    );

  const url = new URL(req.url);
  if (url.searchParams.get("error")) {
    return fail(`Google: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = cookies();
  const expected = jar.get("cf_oauth_state")?.value;
  jar.delete("cf_oauth_state");
  if (!code || !state || !expected || state !== expected) {
    return fail("OAuth state mismatch — please try again.");
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const sb = getSupabase();
  if (!clientId || !clientSecret || !sb || !isConfigured()) {
    return fail("Server not configured for Google OAuth.");
  }
  // Bind the connection to the signed-in ClipFlow user (multi-user).
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.redirect(`${appOrigin}/login?next=/connections`);
  }

  try {
    // 1. Code -> tokens.
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(req),
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token || !tokens.access_token) {
      return fail(
        `Token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.status}`
      );
    }

    // 2. Who is this for?
    const meRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me.email) {
      return fail("Could not read the Google account email.");
    }

    // 3. Store the encrypted worker-usable secret (AES-256-GCM, never logged).
    const secret = {
      kind: "oauth",
      email: me.email,
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
    };
    const { error } = await sb
      .from("connections")
      .upsert(
        {
          service: "gmail",
          method: "oauth",
          user_id: sessionUser.id,
          label: me.email,
          status: "verified",
          secret_enc: encryptSecret(secret),
          meta: { oauth_at: new Date().toISOString(), scope: "gmail.readonly" },
        },
        { onConflict: "user_id,service,method" }
      );
    if (error) return fail(`Could not save connection: ${error.message}`);

    return NextResponse.redirect(
      `${appOrigin}/connections?oauth=ok&service=gmail`
    );
  } catch (e) {
    return fail(`OAuth failed: ${(e as Error).message}`);
  }
}
