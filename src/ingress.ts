import { LIMITS, SOURCES, lookup, type SourceConfig } from "./config.ts";
import { decodeSigningSecret, verifyStandardWebhook } from "./standard-webhooks.ts";
import { HttpError } from "./access.ts";
import { relayStub } from "./relay.ts";

async function readLimited(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) throw new HttpError(413, "body_too_large");
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) throw new HttpError(413, "body_too_large");
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function checkBody(config: SourceConfig, body: Uint8Array): boolean {
  if (config.bodyCheck !== "fumi-notification") return true;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const { kind, messageId } = value as Record<string, unknown>;
    return (
      kind === "notification" &&
      typeof messageId === "string" &&
      /^mail_[a-zA-Z0-9-]{1,128}$/.test(messageId)
    );
  } catch {
    return false;
  }
}

/** `POST /in/<source>`: verify, then deduplicate and forward inside the Relay. */
export async function handleIngress(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  source: string,
): Promise<Response> {
  const config = lookup(SOURCES, source);
  if (!config) throw new HttpError(404, "not_found");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const body = await readLimited(request, LIMITS.maxBodyBytes);
  const secret = decodeSigningSecret(env[config.secret]);
  if (!secret) {
    console.log(JSON.stringify({ event: "ingress", source, outcome: "source_not_configured" }));
    throw new HttpError(503, "unavailable");
  }
  const webhookId = await verifyStandardWebhook(secret, request.headers, body, Date.now());
  if (!webhookId) throw new HttpError(401, "invalid_signature");
  if (!checkBody(config, body)) throw new HttpError(400, "invalid_body");
  // Run the forward under waitUntil, so a source that disconnects cannot cut
  // the Relay off between sending and recording the outcome.
  const delivery = relayStub(env)
    .deliver(source, webhookId, body)
    .catch(() => {
      console.log(JSON.stringify({ event: "ingress", source, outcome: "relay_error" }));
      return "retry" as const;
    });
  ctx.waitUntil(delivery);
  const outcome = await delivery;
  return outcome === "forwarded"
    ? Response.json({ status: "forwarded" })
    : Response.json({ error: { code: "unavailable" } }, { status: 503 });
}
