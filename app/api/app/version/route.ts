import { NextResponse } from "next/server";
import { getLatestReleaseInfo } from "@/lib/releases";
import { requireAdmin } from "@/lib/admin";

/**
 * GET /api/app/version — PUBLIC, no auth.
 * AutoClip app bina login latest release check karta hai:
 *   {version_code, version_name, apk_url, changelog, force_update}
 *
 * RELEASES manifest (lib/releases.ts) se serve hota hai — DB query nahi,
 * taaki PostgREST ke `?order=..&limit=1` quirk se galat version na jaye.
 * Koi release publish nahi hui to 404 + {}.
 *
 * ?diag=1 — admin-gated diagnostics (kaunsa source, kaunsi entry).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rel = getLatestReleaseInfo();
  const { searchParams } = new URL(req.url);

  if (searchParams.get("diag") === "1") {
    const gate = await requireAdmin();
    if (gate instanceof NextResponse) return gate;
    return NextResponse.json({
      diag: true,
      source: "RELEASES manifest (lib/releases.ts)",
      release: rel,
    });
  }

  if (!rel) {
    return NextResponse.json({}, { status: 404 });
  }
  return NextResponse.json({
    version_code: rel.version_code,
    version_name: rel.version_name,
    apk_url: rel.apk_url,
    changelog: rel.changelog ?? "",
    force_update: Boolean(rel.force_update),
  });
}
