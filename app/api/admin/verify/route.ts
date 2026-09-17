import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  isAdminPasswordConfigured,
  isOwnerEmail,
  setAdminCookie,
  verifyAdminPassword,
} from "@/lib/admin";

/**
 * POST { password } — second admin gate.
 * Caller must already be signed in as the owner email; the password is
 * compared server-side against ADMIN_PANEL_PASSWORD (never sent to client).
 * On success sets the httpOnly signed cf_admin cookie (12h).
 */
export async function POST(req: Request) {
  if (!isAdminPasswordConfigured()) {
    return NextResponse.json(
      { error: "ADMIN_PANEL_PASSWORD is not set in Vercel yet." },
      { status: 503 }
    );
  }
  const user = await getSessionUser();
  if (!user || !isOwnerEmail(user.email)) {
    return NextResponse.json({ error: "Admin access only." }, { status: 403 });
  }
  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    password = "";
  }
  if (!verifyAdminPassword(password)) {
    return NextResponse.json({ error: "Galat password. Dobara try karo." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  setAdminCookie(res, user.email as string);
  return res;
}
