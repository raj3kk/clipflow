/**
 * Latest published app release — WP4 piggyback (2026-09-20).
 *
 * jobs/next aur heartbeat responses me chhota `app_update` field jata hai
 * taaki phone ko alag /api/app/version call na karni pade (network bachat).
 * Phone isse event-driven update check chalata hai; force_update=true pe
 * naya run start nahi hota (phone-side fail-closed).
 *
 * Best-effort: kabhi throw nahi karta — null = pata nahi / koi release nahi.
 */

export interface AppReleaseInfo {
  version_code: number;
  version_name: string;
  apk_url: string;
  force_update: boolean;
}

export async function getLatestRelease(sb: any): Promise<AppReleaseInfo | null> {
  try {
    const { data: rows } = await sb
      .from("app_releases")
      .select("version_code, version_name, apk_url, force_update")
      .order("version_code", { ascending: false })
      .limit(1);
    const r = rows?.[0] as
      | {
          version_code?: number;
          version_name?: string | null;
          apk_url?: string | null;
          force_update?: boolean | null;
        }
      | undefined;
    if (!r || !r.version_code || !r.apk_url) return null;
    return {
      version_code: r.version_code,
      version_name: r.version_name ?? `v${r.version_code}`,
      apk_url: r.apk_url,
      force_update: Boolean(r.force_update),
    };
  } catch {
    return null;
  }
}
