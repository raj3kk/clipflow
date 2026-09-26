import { createHmac, randomInt, timingSafeEqual } from "crypto";

/**
 * Stateless pairing codes — original ClipFlow design.
 *
 * Koi DB table nahi: code khud me expiry rakhta hai aur server secret
 * (WORKER_SECRET, domain-separated) se HMAC-SHA256 signed hota hai.
 *
 * Format: 13-char Crockford base32, displayed XXXXX-XXXX-XXXX
 *   bits: [ expiry:30 | nonce:10 | mac:25 ]  (65 bits = 13 chars)
 *   expiry: EPOCH (2026-01-01) se seconds, ~2060 tak valid range
 *   nonce:  10-bit random — same-second duplicate codes nahi
 *   mac:    HMAC-SHA256(key, "clipflow-pairing-v1" || expiry || nonce)
 *           ke first 25 bits. 30/min rate limit ke saath forgery
 *           infeasible hai (10-min window me max ~300 guesses).
 * TTL: 10 minutes. Single-use: enroll route successful redeem ko
 * existing `activity_log` table me (event='pairing_code_used',
 * detail.code) record karta hai — nayi table/column ke bina
 * cross-instance single-use guarantee.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EPOCH = 1767225600; // 2026-01-01T00:00:00Z
const TTL_SECONDS = 10 * 60;
const MAC_DOMAIN = "clipflow-pairing-v1";

function pairingKey(): Buffer {
  const s = process.env.WORKER_SECRET;
  if (!s) throw new Error("WORKER_SECRET is not set.");
  // Domain separation: worker-auth secret ko pairing MAC key ke roop me reuse nahi.
  return createHmac("sha256", s).update(MAC_DOMAIN, "utf8").digest();
}

function toCrockford(value: number, chars: number): string {
  let out = "";
  for (let i = chars - 1; i >= 0; i--) {
    out += CROCKFORD[(value >>> (i * 5)) & 31];
  }
  return out;
}

function fromCrockford(s: string): number {
  let v = 0;
  for (const ch of s) v = v * 32 + CROCKFORD.indexOf(ch);
  return v;
}

/** expiry(30b) || nonce(10b) → 5 bytes big-endian (MAC message). */
function packExpNonce(exp30: number, nonce10: number): Buffer {
  const v = exp30 * 1024 + nonce10; // < 2^40
  const b = Buffer.alloc(5);
  b[0] = Math.floor(v / 0x100000000);
  b.writeUInt32BE(v % 0x100000000, 1);
  return b;
}

function computeMac(key: Buffer, exp30: number, nonce10: number): number {
  const digest = createHmac("sha256", key)
    .update(packExpNonce(exp30, nonce10))
    .digest();
  return digest.readUInt32BE(0) >>> 7; // first 25 bits
}

/** User input normalize: dashes/spaces nikalo, uppercase, I/L→1, O→0. */
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0");
}

export function formatCode(raw13: string): string {
  return `${raw13.slice(0, 5)}-${raw13.slice(5, 9)}-${raw13.slice(9, 13)}`;
}

export function generatePairingCode(): { code: string; expiresAt: Date } {
  const key = pairingKey();
  const expUnix = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const exp30 = expUnix - EPOCH;
  if (exp30 < 0 || exp30 >= 2 ** 30) throw new Error("Pairing epoch out of range.");
  const nonce10 = randomInt(0, 1024);
  const mac = computeMac(key, exp30, nonce10);
  const raw = toCrockford(exp30, 6) + toCrockford(nonce10, 2) + toCrockford(mac, 5);
  return { code: formatCode(raw), expiresAt: new Date(expUnix * 1000) };
}

export type VerifyResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "format" | "expired" | "mismatch" };

export function verifyPairingCode(input: string): VerifyResult {
  const raw = normalizeCode(input);
  if (raw.length !== 13 || raw.split("").some((c) => CROCKFORD.indexOf(c) < 0)) {
    return { ok: false, reason: "format" };
  }
  const exp30 = fromCrockford(raw.slice(0, 6));
  const nonce10 = fromCrockford(raw.slice(6, 8));
  const mac = fromCrockford(raw.slice(8, 13));
  const expUnix = EPOCH + exp30;
  if (expUnix <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  const key = pairingKey();
  const expected = computeMac(key, exp30, nonce10);
  const a = Buffer.alloc(4);
  const b = Buffer.alloc(4);
  a.writeUInt32BE(mac * 128, 0);
  b.writeUInt32BE(expected * 128, 0);
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true, expiresAt: new Date(expUnix * 1000) };
}

/** Rate-limit tuning (enforced in enroll route via activity_log). */
export const PAIRING_RATE_LIMIT = 30; // requests
export const PAIRING_RATE_WINDOW_MS = 60_000; // per minute, per IP
/**
 * Code-fingerprint scoped limiter: IP rotation se immune.
 * Har normalized code pe 10 attempts / 10 min — brute-forcer IP badal kar
 * bhi nahi bach sakta; legit user (2-3 typo) kabhi nahi atkega.
 */
export const PAIRING_CODE_RATE_LIMIT = 10; // attempts
export const PAIRING_CODE_RATE_WINDOW_MS = 10 * 60_000; // per 10 minutes, per code
