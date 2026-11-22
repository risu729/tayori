import { env } from "cloudflare:workers";

const encoder = new TextEncoder();

export async function signedRequest(
  body: string,
  options: { id?: string; timestamp?: number; secret?: string; host?: string } = {},
): Promise<Request> {
  const id = options.id ?? `op_${crypto.randomUUID()}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = options.secret ?? env.SOURCE_FUMI_SECRET!;
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`)),
  );
  return new Request(`https://${options.host ?? "tayori.takuk.me"}/in/fumi`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
    },
    body,
  });
}

export const notification = (messageId = "mail_test-0001") =>
  JSON.stringify({ schemaVersion: 1, kind: "notification", operationId: "op", messageId });

let lastLease = Math.floor(Date.now() / 1000) - 3600;
/** Strictly increasing lease times, since the Relay keeps state across tests. */
export function nextLease(): number {
  lastLease += 1;
  return lastLease;
}
