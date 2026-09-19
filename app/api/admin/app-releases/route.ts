import { NextResponse } from "next/server";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin";

/**
 * Admin-only app-release management (AutoClip in-app auto-update).
 * Double-gated by requireAdmin(): owner email + admin password cookie.
 *
 * GET  → purane releases ki list (version_code desc)
 * POST → naya release publish: {version_code, version_name, apk_url,
 *         changelog, force_update}. version_code UNIQUE hai — dobara
 *         publish karne pe wahi version update ho jata hai (upsert).
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const { data, error } = await sb
    .from("app_releases")
    .select("version_code, version_name, apk_url, changelog, force_update, published_at")
    .order("version_code", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ releases: data ?? [] });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const version_code = Number(body.version_code);
  const version_name = String(body.version_name ?? "").trim();
  const apk_url = String(body.apk_url ?? "").trim();
  const changelog = String(body.changelog ?? "").trim();
  const force_update = Boolean(body.force_update);

  if (!Number.isInteger(version_code) || version_code <= 0) {
    return NextResponse.json({ error: "version_code ek positive integer hona chahiye." }, { status: 400 });
  }
  if (!version_name) {
    return NextResponse.json({ error: "version_name zaroori hai." }, { status: 400 });
  }
  if (!/^https:\/\//i.test(apk_url)) {
    return NextResponse.json({ error: "apk_url https:// se shuru hona chahiye." }, { status: 400 });
  }

  const { error } = await sb.from("app_releases").upsert(
    {
      version_code,
      version_name,
      apk_url,
      changelog,
      force_update,
      published_at: new Date().toISOString(),
    },
    { onConflict: "version_code" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, version_code });
}
