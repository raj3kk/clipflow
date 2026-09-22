/**
 * Server-side only: AES-256-GCM encrypt/decrypt for connection secrets.
 *
 * Key: process.env.CONNECTIONS_ENCRYPT_KEY — 64 hex chars (32 random bytes).
 * Payload: base64(JSON.stringify({ iv, tag, data }))
 *   iv   = 12-byte random IV, hex
 *   tag  = 16-byte GCM auth tag, hex (tampering fails decryption)
 *   data = ciphertext, hex
 *
 * Never import this from client components.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("lib/crypto.ts is server-only and must not run in the browser.");
}

function getKey(): Buffer {
  const hex = process.env.CONNECTIONS_ENCRYPT_KEY;
  if (!hex) {
    throw new Error(
      "CONNECTIONS_ENCRYPT_KEY is not set. Set it to 64 hex characters " +
        "(32 random bytes) in the environment before storing secrets."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "CONNECTIONS_ENCRYPT_KEY must be exactly 64 hex characters (32 bytes)."
    );
  }
  return Buffer.from(hex, "hex");
}

interface Envelope {
  iv: string;
  tag: string;
  data: string;
}

/** Encrypt any JSON-serializable value. Returns base64 envelope string. */
export function encryptSecret(value: unknown): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(value);
  const data = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  const envelope: Envelope = { iv: iv.toString("hex"), tag, data };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Decrypt a payload produced by encryptSecret(). Throws on tamper/wrong key. */
export function decryptSecret<T>(s: string): T {
  const key = getKey();
  let envelope: Envelope;
  try {
    envelope = JSON.parse(
      Buffer.from(s, "base64").toString("utf8")
    ) as Envelope;
  } catch {
    throw new Error("Invalid encrypted payload: not a valid base64 envelope.");
  }
  if (!envelope?.iv || !envelope?.tag || !envelope?.data) {
    throw new Error("Invalid encrypted payload: missing iv/tag/data.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  const plaintext =
    decipher.update(envelope.data, "hex", "utf8") + decipher.final("utf8");
  return JSON.parse(plaintext) as T;
}
