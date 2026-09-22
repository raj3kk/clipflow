import { NextResponse } from "next/server";

/**
 * GET /api/app/latest — PUBLIC, no auth.
 * Hamesha latest published APK pe 307 redirect.
 * Guide/download buttons ke liye stable link (versioned URL har release
 * me badalta hai). Koi release nahi to 404.
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
      `${url.replace(/\/$/, "")}/rest/v1/app_releases?select=apk_url&order=version_code.desc&limit=1`,
      {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        cache: "no-store",
      }
    );
    if (!r.ok) return NextResponse.json({}, { status: 404 });
    const rows = (await r.json()) as Array<{ apk_url?: string }>;
    const apkUrl = rows?.[0]?.apk_url;
    if (!apkUrl || !/^https:\/\//i.test(apkUrl)) {
      return NextResponse.json({}, { status: 404 });
    }
    return NextResponse.redirect(apkUrl, 307);
  } catch {
    return NextResponse.json({}, { status: 404 });
  }
}
