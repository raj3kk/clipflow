import { NextResponse } from "next/server";

/**
 * GET /api/app/version — PUBLIC, no auth.
 * AutoClip app bina login latest release check karta hai:
 *   {version_code, version_name, apk_url, changelog, force_update}
 * Koi release publish nahi hui to 404 + {}.
 *
 * Anon key se padhta hai taaki RLS ("public read app_releases") enforce ho.
 *
 * NOTE (2026-09-19, round-6 Worker E): yahan @supabase/supabase-js use NAHI
 * karte — uska request Vercel runtime me khaali result deta hai jabki same
 * URL+key pe raw fetch 200 + row deta hai (debug me verify). Isliye seedha
 * PostgREST REST call hai. Koi secret kabhi log/response me nahi aata.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json({}, { status: 404 });
  }
  try {
    const r = await fetch(
      `${url.replace(/\/$/, "")}/rest/v1/app_releases?select=version_code,version_name,apk_url,changelog,force_update&order=version_code.desc&limit=1`,
      {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        cache: "no-store",
      }
    );
    if (!r.ok) {
      return NextResponse.json({}, { status: 404 });
    }
    const rows = (await r.json()) as Array<{
      version_code: number;
      version_name: string;
      apk_url: string;
      changelog?: string | null;
      force_update?: boolean | null;
    }>;
    const row = rows?.[0];
    if (!row) {
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
