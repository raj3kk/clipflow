import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/app/version — PUBLIC, no auth.
 * AutoClip app bina login latest release check karta hai:
 *   {version_code, version_name, apk_url, changelog, force_update}
 * Koi release publish nahi hui to 404 + {}.
 *
 * Anon key se padhta hai taaki RLS ("public read app_releases") enforce ho.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json({}, { status: 404 });
  }
  try {
    const sb = createClient(url, anon);
    // NOTE: .maybeSingle() yahan use NAHI karte — uska
    // `Accept: application/vnd.pgrst.object+json` header Vercel runtime me
    // khaali result deta hai (2026-09-19 debug: raw fetch 200 + row milti
    // hai, maybeSingle null deta hai). .limit(1) + data[0] reliable hai.
    const { data, error } = await sb
      .from("app_releases")
      .select("version_code, version_name, apk_url, changelog, force_update")
      .order("version_code", { ascending: false })
      .limit(1);
    const row = (data ?? [])[0];
    if (error || !row) {
      return NextResponse.json({}, { status: 404 });
    }
    return NextResponse.json({
      version_code: row.version_code,
      version_name: row.version_name,
      apk_url: row.apk_url,
      changelog: row.changelog ?? "",
      force_update: Boolean(row.force_update),
    });
  } catch {
    return NextResponse.json({}, { status: 404 });
  }
}
