/**
 * App releases manifest — AutoClip latest-release ka source of truth.
 *
 * GET /api/app/version aur jobs/next|heartbeat ke `app_update` piggyback
 * isi manifest se serve hote hain — DB query NAHI. Wajah: is Supabase
 * project pe PostgREST ka `?order=...&limit=1` ordered select galat row
 * lauta sakta hai (stale/wrong version phone tak pahunch jata hai).
 *
 * Naya APK publish karte waqt:
 *   1. APK ko public/app/autoclip-<version>.apk me rakho,
 *   2. yahan RELEASES[0] entry update karo (version_code hamesha badhao),
 *   3. app_releases table me bhi row upsert karo (record ke liye).
 */

export interface ReleaseInfo {
  version_code: number;
  version_name: string;
  apk_url: string;
  changelog: string;
  force_update: boolean;
}

export const RELEASES: ReleaseInfo[] = [
  {
    version_code: 71,
    version_name: "0.1.0-p70",
    apk_url: "https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p70.apk",
    changelog:
      "p70: eval_strict action, assert message fill, phone-side observability (shot upload, heartbeat)",
    force_update: false,
  },
];

export function getLatestReleaseInfo(): ReleaseInfo | null {
  return RELEASES[0] ?? null;
}
