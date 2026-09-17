import { NextResponse } from "next/server";
import { clearAdminCookie } from "@/lib/admin";

/** POST — drop the admin session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearAdminCookie(res);
  return res;
}
