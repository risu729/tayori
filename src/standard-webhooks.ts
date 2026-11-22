/** Standard Webhooks verification (https://www.standardwebhooks.com/) over the
 * exact body bytes. */
import { LIMITS } from "./config.ts";

const WEBHOOK_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

/** A `whsec_` secret: canonical base64 of 24 to 64 random bytes. */
export function decodeSigningSecret(secret: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
    if (bytes.length < 24 || bytes.length > 64) return null;
    if (btoa(String.fromCharCode(...bytes)) !== secret.slice(6)) return null;
    return bytes;
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Returns the `webhook-id` when the signature and timestamp check out, else null. */
export async function verifyStandardWebhook(
  secret: Uint8Array<ArrayBuffer>,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>,
  nowMs: number,
): Promise<string | null> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !WEBHOOK_ID.test(id) || !timestamp || !/^\d{1,12}$/.test(timestamp)) return null;
  if (!signatures || signatures.length > 4096) return null;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > LIMITS.timestampToleranceSeconds)
    return null;
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const candidates = signatures
    .split(" ")
    .slice(0, 8)
    .map((entry) => entry.split(",", 2))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => decodeBase64(value!))
    .filter((signature) => signature !== null);
  // crypto.subtle.verify compares in constant time.
  const results = await Promise.all(
    candidates.map((signature) => crypto.subtle.verify("HMAC", key, signature, signed)),
  );
  if (results.includes(true)) return id;
  return null;
}
