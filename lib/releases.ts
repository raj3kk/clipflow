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
    version_code: 74,
    version_name: "0.1.0-p73",
    apk_url: "https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p73.apk",
    sha256: "77173ba890965e88ca26bf838e5e861c3b910dfb354cd33fef56abc47d5fe99d",
    changelog:
      "p73 (version bump): p72 code as-is, version 74. Same signing key — purane p72 ke upar direct update hoga.",
    force_update: true,
  },
  {
    version_code: 73,
    version_name: "0.1.0-p72",
    apk_url: "https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p72.apk",
    sha256: "aeb491f364e651c533d79ff325d891084f89eb9a12ef4692228621d4c00dd4da",
    changelog:
      "p72 (boot-crash fix): work-runtime ka Room InvalidationTracker androidx.arch.core SafeIterableMap mangta hai — core-common jar dex me add kiya (p71 boot pe NoClassDefFoundError crash hota tha). Saath me Scheduler/BootReceiver me catch Throwable taaki koi missing class dobara boot crash na kare. Same signing key — purane p71 ke upar direct update hoga.",
    force_update: true,
  },
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
