/**
 * FCM push — HTTP v1 API (server-side, service account se).
 *
 * Setup (owner ka ~5 min ka kaam, ek baar):
 *   1. console.firebase.google.com → naya project (free, Spark plan)
 *   2. Project settings → Service accounts → Generate new private key (JSON)
 *   3. Vercel env: FIREBASE_SERVICE_ACCOUNT = poora JSON (ek line me)
 *   4. google-services.json phone app me (APK rebuild)
 *
 * Jab tak env nahi hai, wake "poll" mode me rehta hai — phone apne
 * schedule pe job utha lega. Koi crash nahi, koi silent fail nahi.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedToken: { token: string; exp: number } | null = null;

function getServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (sa.project_id && sa.client_email && sa.private_key) return sa;
    return null;
  } catch {
    return null;
  }
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  // 5 min cache
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const { JWT } = await import("google-auth-library");
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("FCM access token nahi mila.");
  cachedToken = { token, exp: Date.now() + 50 * 60_1000 };
  return token;
}

export async function sendWakePush(
  fcmToken: string
): Promise<{ sent: boolean; via: "fcm" | "poll"; reason?: string }> {
  const sa = getServiceAccount();
  if (!sa) {
    return {
      sent: false,
      via: "poll",
      reason: "FCM not configured (FIREBASE_SERVICE_ACCOUNT missing).",
    };
  }
  try {
    const accessToken = await getAccessToken(sa);
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            data: { wake: "1" },
            android: { priority: "high" },
          },
        }),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        sent: false,
        via: "poll",
        reason: `FCM HTTP ${res.status}: ${t.slice(0, 200)}`,
      };
    }
    return { sent: true, via: "fcm" };
  } catch (e) {
    return {
      sent: false,
      via: "poll",
      reason: e instanceof Error ? e.message : "FCM send failed.",
    };
  }
}

export function isFcmConfigured(): boolean {
  return getServiceAccount() !== null;
}
