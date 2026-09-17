import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionUser } from "./auth";

/**
 * Admin gate for ClipFlow.
 *
 * Two layers, both enforced server-side:
 *  1. The signed-in Supabase user must be the owner email
 *     (ADMIN_OWNER_EMAIL, default flipify.com@gmail.com).
 *  2. A separate admin-panel password must be supplied once per 12h.
 *     The password lives ONLY in the ADMIN_PANEL_PASSWORD env var
 *     (set in Vercel) and is compared with a constant-time check.
 *     On success we set an httpOnly signed cookie — the password itself
 *     never goes to the client.
 */

export const ADMIN_COOKIE = "cf_admin";
const ADMIN_COOKIE_MAX_AGE = 12 * 3600;

export function ownerEmail(): string {
  return (process.env.ADMIN_OWNER_EMAIL || "flipify.com@gmail.com").toLowerCase();
}

export function isOwnerEmail(email?: string | null): boolean {
  return (email || "").toLowerCase() === ownerEmail();
}

export function isAdminPasswordConfigured(): boolean {
  return Boolean(process.env.ADMIN_PANEL_PASSWORD);
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time comparison of the supplied password against the env var. */
export function verifyAdminPassword(input: string): boolean {
  const expected = process.env.ADMIN_PANEL_PASSWORD;
  if (!expected || !input) return false;
  const a = sha256(input);
  const b = sha256(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminMac(email: string): string {
  return createHmac("sha256", process.env.ADMIN_PANEL_PASSWORD as string)
    .update(`clipflow-admin|${email.toLowerCase()}`, "utf8")
    .digest("hex");
}

/** Stateless signed token: base64url(email).hmac. Invalidates if the env password changes. */
export function signAdminCookie(email: string): string {
  const e = email.toLowerCase();
  return `${Buffer.from(e, "utf8").toString("base64url")}.${adminMac(e)}`;
}

export function verifyAdminCookie(value: string | undefined | null): string | null {
  if (!value || !isAdminPasswordConfigured()) return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const b64 = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  let email: string;
  try {
    email = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!isOwnerEmail(email)) return null;
  const expected = adminMac(email);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return email;
}

export function setAdminCookie(res: NextResponse, email: string): void {
  res.cookies.set(ADMIN_COOKIE, signAdminCookie(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  });
}

export function clearAdminCookie(res: NextResponse): void {
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Server-side gate for /api/admin/* routes.
 * Returns { email } when the caller passes both layers,
 * otherwise a JSON error Response (401 / 403 / 503).
 */
export async function requireAdmin(): Promise<{ email: string } | NextResponse> {
  if (!isAdminPasswordConfigured()) {
    return NextResponse.json(
      { error: "Admin panel password is not configured yet. Set ADMIN_PANEL_PASSWORD in Vercel.", notConfigured: true },
      { status: 503 }
    );
  }
  const user = await getSessionUser();
  if (!user || !isOwnerEmail(user.email)) {
    return NextResponse.json({ error: "Admin access only." }, { status: 403 });
  }
  const jar = cookies();
  const authed = verifyAdminCookie(jar.get(ADMIN_COOKIE)?.value);
  if (!authed) {
    return NextResponse.json({ error: "Admin password required.", needPassword: true }, { status: 401 });
  }
  return { email: authed };
}
