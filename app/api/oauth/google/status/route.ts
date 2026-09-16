import { NextResponse } from "next/server";

/**
 * Public: is Google OAuth configured for ClipFlow?
 * The Connections UI uses this to show either the real "Connect with Google"
 * button or honest setup instructions.
 */
export async function GET() {
  const configured = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  return NextResponse.json({ configured });
}
