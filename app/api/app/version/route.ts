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
    const { data, error } = await sb
      .from("app_releases")
      .select("version_code, version_name, apk_url, changelog, force_update")
      .order("version_code", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json({}, { status: 404 });
    }
    return NextResponse.json({
      version_code: data.version_code,
      version_name: data.version_name,
      apk_url: data.apk_url,
      changelog: data.changelog ?? "",
      force_update: Boolean(data.force_update),
    });
  } catch {
    return NextResponse.json({}, { status: 404 });
  }
}
