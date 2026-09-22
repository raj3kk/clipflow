import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminPasswordConfigured, isOwnerEmail, verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import { cookies } from "next/headers";

/**
 * GET — tells the signed-in user whether they are the owner and whether
 * the admin password gate is configured. No secrets are exposed.
 * Used by the nav to show the Admin link only to the owner.
 */
export async function GET() {
  const user = await getSessionUser();
  const owner = isOwnerEmail(user?.email);
  const authed = owner && Boolean(verifyAdminCookie(cookies().get(ADMIN_COOKIE)?.value));
  return NextResponse.json({
    signedIn: Boolean(user),
    isOwner: owner,
    adminAuthed: authed,
    passwordConfigured: isAdminPasswordConfigured(),
  });
}
