import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import {
  WHOP_TOKEN_URL,
  WHOP_USERINFO_URL,
  whopCallbackUrl,
  getWhopOAuthAppConfig,
} from "@/lib/whop-oauth";

/**
 * Whop OAuth callback: verifies state, exchanges the code (PKCE) for tokens
 * server-side, fetches the Whop profile, and stores an encrypted whop/oauth
 * connection the worker can use via /api/whop/request (Bearer token, with
 * refresh). Never logs or returns any token.
 */
export async function GET(req: Request) {
  const appOrigin = new URL(req.url).origin;
  const fail = (msg: string) =>
    NextResponse.redirect(
      `${appOrigin}/connections?oauth=error&detail=${encodeURIComponent(msg)}`
    );

  const url = new URL(req.url);
  if (url.searchParams.get("error")) {
    return fail(
      `Whop: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = cookies();
  const expectedState = jar.get("cf_whop_oauth_state")?.value;
  const verifier = jar.get("cf_whop_pkce_verifier")?.value;
  const expectedNonce = jar.get("cf_whop_oauth_nonce")?.value;
  jar.delete("cf_whop_oauth_state");
  jar.delete("cf_whop_pkce_verifier");
  jar.delete("cf_whop_oauth_nonce");
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return fail("OAuth state mismatch — please try again.");
  }

  const appCfg = await getWhopOAuthAppConfig();
  const sb = getSupabase();
  if (!appCfg || !sb || !isConfigured()) {
    return fail("Server not configured for Whop OAuth.");
  }
  const clientId = appCfg.clientId;
  const clientSecret = appCfg.clientSecret;
  // Bind the connection to the signed-in ClipFlow user (multi-user).
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.redirect(`${appOrigin}/login?next=/connections`);
  }

  try {
    // 1. Code -> tokens (server-side; Vercel's network reaches Whop fine).
    const tokenRes = await fetch(WHOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: whopCallbackUrl(req),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return fail(
        `Token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.status}`
      );
    }

    // 1b. Verify the OIDC nonce inside the id_token when Whop returns one.
    if (tokens.id_token && expectedNonce) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
        );
        if (payload.nonce !== expectedNonce) {
          return fail("OAuth nonce mismatch — please try again.");
        }
      } catch {
        return fail("Could not verify the Whop sign-in token — please try again.");
      }
    }

    // 2. Who is this for?
    const meRes = await fetch(WHOP_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = await meRes.json();
    if (!meRes.ok) {
      return fail("Could not read the Whop profile.");
    }
    const whopUserId: string = me.id ?? me.sub ?? "";
    const label: string =
      me.username ?? me.email ?? me.name ?? whopUserId ?? "whop";

    // 3. Store the encrypted worker-usable secret (AES-256-GCM, never logged).
    const secret = {
      kind: "oauth",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : null,
      token_type: tokens.token_type ?? "Bearer",
      whop_user_id: whopUserId,
      client_id: clientId,
      client_secret: clientSecret,
    };
    const { error } = await sb
      .from("connections")
      .upsert(
        {
          service: "whop",
          method: "oauth",
          user_id: sessionUser.id,
          label: `Whop (${label})`,
          status: "verified",
          secret_enc: encryptSecret(secret),
          last_verified: new Date().toISOString(),
          meta: {
            oauth_at: new Date().toISOString(),
            scope: "openid profile email",
            whop_user_id: whopUserId,
          },
        },
        { onConflict: "user_id,service,method" }
      );
    if (error) return fail(`Could not save connection: ${error.message}`);

    return NextResponse.redirect(
      `${appOrigin}/connections?oauth=ok&service=whop`
    );
  } catch (e) {
    return fail(`OAuth failed: ${(e as Error).message}`);
  }
}
