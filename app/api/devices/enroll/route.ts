import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { hashApiKey } from "@/lib/device_auth";
import { ownerEmail } from "@/lib/admin";
import {
  verifyPairingCode,
  normalizeCode,
  PAIRING_RATE_LIMIT,
  PAIRING_RATE_WINDOW_MS,
  PAIRING_CODE_RATE_LIMIT,
  PAIRING_CODE_RATE_WINDOW_MS,
} from "@/lib/pairing";

/**
 * Phone app ka enroll: { code, device_name?, app_version? }
 *
 * Original ClipFlow contract (stateless HMAC pairing, lib/pairing.ts):
 *   code missing            → 400
 *   code galat/expired/used → 403  (401 NAHI)
 *   30/min per IP           → 429
 *   10/10min per code       → 429  (IP rotation se immune code fingerprint)
 *
 * Code me koi DB lookup nahi — HMAC verify hota hai. Single-use aur
 * rate-limit existing `activity_log` table pe hain (koi nayi table ya
 * column nahi): event='pairing_code_used' / 'pairing_attempt'.
 *
 * Code verify → device row banao → device_id + api_key wapas.
 * api_key RAW sirf isi response me dikhegi (dobara kabhi nahi) —
 * phone ise apne encrypted storage me rakhta hai.
 *
 * Device KISKE account se judega: code stateless hai, isliye generate
 * route `activity_log` me event='pairing_code_issued' (detail.code) likhta
 * hai. Yahan us code ka sabse taaza issuance dekh kar usi user_id se
 * device jodte hain. Issuance na mile (purana admin flow / manual code)
 * to owner account fallback — pehle jaisa behavior.
 */
type Sb = NonNullable<ReturnType<typeof getSupabase>>;

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

async function getOwnerUserId(sb: Sb): Promise<string | null> {
  const email = ownerEmail();
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 100 });
    if (error || !data?.users) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 100) return null;
    page += 1;
    if (page > 20) return null;
  }
}

/**
 * Rate limit — activity_log backed (cross-instance):
 *   (a) 30/min per IP (pehle jaisa),
 *   (b) 10/10min per normalized code — IP rotation se immune.
 * (b) isliye: VM/proxy egress IP har connection pe badal sakta hai
 * (2026-09-27: 12 rapid requests pe ~7 alag egress IPs dekhe), jisse
 * per-IP bucket kabhi nahi bharta tha. Code fingerprint har attempt me
 * log hota hai, isliye brute-forcer IP badal kar nahi bach sakta.
 * Fail-closed: DB error ya limit breach — dono pe 429.
 */
async function checkRateLimit(
  sb: Sb,
  ip: string,
  codeId: string
): Promise<boolean> {
  const now = Date.now();
  const sinceIp = new Date(now - PAIRING_RATE_WINDOW_MS).toISOString();
  const { count: ipCount, error: ipErr } = await sb
    .from("activity_log")
    .select("id", { count: "exact", head: true })
    .eq("event", "pairing_attempt")
    .filter("detail->>ip", "eq", ip)
    .gt("ts", sinceIp);
  // Fail-closed: DB error ya limit breach — dono pe 429.
  if (ipErr || (ipCount ?? 0) >= PAIRING_RATE_LIMIT) return false;

  const sinceCode = new Date(now - PAIRING_CODE_RATE_WINDOW_MS).toISOString();
  const { count: codeCount, error: codeErr } = await sb
    .from("activity_log")
    .select("id", { count: "exact", head: true })
    .eq("event", "pairing_attempt")
    .filter("detail->>code", "eq", codeId)
    .gt("ts", sinceCode);
  // Fail-closed: DB error ya limit breach — dono pe 429.
  if (codeErr || (codeCount ?? 0) >= PAIRING_CODE_RATE_LIMIT) return false;

  await sb.from("activity_log").insert({
    user_id: null,
    actor: "pairing",
    event: "pairing_attempt",
    detail: { ip, code: codeId },
  });
  return true;
}

async function isCodeUsed(sb: Sb, raw13: string): Promise<boolean> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("activity_log")
    .select("id")
    .eq("event", "pairing_code_used")
    .filter("detail->>code", "eq", raw13)
    .gt("ts", since)
    .limit(1);
  return Boolean(data && data.length > 0);
}

/**
 * Is code ko sabse taaza kisne issue kiya (10-min window)?
 * Generate route har code ke liye event='pairing_code_issued' likhta hai.
 * Na mile to null → caller owner fallback lega.
 */
async function getIssuingUserId(
  sb: Sb,
  raw13: string
): Promise<string | null> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("activity_log")
    .select("user_id")
    .eq("event", "pairing_code_issued")
    .filter("detail->>code", "eq", raw13)
    .gt("ts", since)
    .order("ts", { ascending: false })
    .limit(1);
  const uid = data?.[0]?.user_id ?? null;
  return typeof uid === "string" && uid ? uid : null;
}

export async function POST(req: Request) {
  const sb = getSupabase();
  if (!sb || !isConfigured()) {
    return NextResponse.json(
      { error: "Supabase not configured." },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const code = String(body.code ?? "").trim();
  if (!code) {
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  }

  // Code fingerprint rate-limit ke liye — HMAC verify se PEHLE nikalte hain
  // (rate-limit check ka order pehle jaisa: verify se pehle). 64-char cap
  // sirf garbage input ko jsonb row bloat karne se rokta hai; asli codes
  // 13-char hote hain, isliye legit bucket pe koi asar nahi.
  const codeId = normalizeCode(code).slice(0, 64);
  if (!(await checkRateLimit(sb, clientIp(req), codeId))) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  const v = verifyPairingCode(code);
  if (!v.ok) {
    const msg =
      v.reason === "expired"
        ? "Pairing code expired. Generate a new one."
        : "Invalid pairing code.";
    return NextResponse.json({ error: msg }, { status: 403 });
  }
  const id = normalizeCode(code);
  if (await isCodeUsed(sb, id)) {
    return NextResponse.json(
      { error: "Pairing code already used." },
      { status: 403 }
    );
  }

  // Device kiske account se judega: code jisne issue kiya uska user_id;
  // issuance record na mile (purana/manual code) to owner fallback.
  const bindUserId =
    (await getIssuingUserId(sb, id)) ?? (await getOwnerUserId(sb));
  if (!bindUserId) {
    return NextResponse.json(
      { error: "Owner account not found." },
      { status: 500 }
    );
  }

  const apiKey = randomBytes(32).toString("hex");
  const { data: device, error: devErr } = await sb
    .from("devices")
    .insert({
      user_id: bindUserId,
      device_name: String(body.device_name ?? "Android"),
      app_version: body.app_version ? String(body.app_version) : null,
      api_key_hash: hashApiKey(apiKey),
      status: "active",
    })
    .select("id")
    .single();

  if (devErr || !device) {
    return NextResponse.json(
      { error: devErr?.message ?? "Enroll failed." },
      { status: 500 }
    );
  }

  // single-use mark (best-effort; code 10 min me expire bhi hota hai)
  await sb.from("activity_log").insert({
    user_id: bindUserId,
    actor: "pairing",
    event: "pairing_code_used",
    detail: { code: id },
  });

  return NextResponse.json({ device_id: device.id, api_key: apiKey });
}
