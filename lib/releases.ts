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
  /** APK ka SHA-256 — phone verify karke hi install kare. */
  sha256: string;
  changelog: string;
  force_update: boolean;
}

export const RELEASES: ReleaseInfo[] = [
  {
    version_code: 72,
    version_name: "0.1.0-p71",
    apk_url: "https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p71.apk",
    sha256: "f98d5254bcb7a43407b60f0e8f317a3f6bc95f9148178b2037813b5d9b21407e",
    changelog:
      "p71 (full rebuild): manual-demo learning, 6-site session sync, app import, per-host USA proxy (Whop/ContentRewards only), Tink encrypted prefs, proxy-policy OkHttp interceptors, Kotlin 1.9 stdlib dex fix. NAYA SIGNING KEY — fresh install zaroori.",
    force_update: true,
  },
];

export function getLatestReleaseInfo(): ReleaseInfo | null {
  return RELEASES[0] ?? null;
}
