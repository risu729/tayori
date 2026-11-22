import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

function allowedPrincipals(serialized: unknown): Set<string> | null {
  if (typeof serialized !== "string" || serialized.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
    if (!value.every((id) => typeof id === "string" && /^(user|service):\S{1,256}$/.test(id)))
      return null;
    return new Set(value as string[]);
  } catch {
    return null;
  }
}

// Cache public verification keys only, never tokens.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies the Cloudflare Access application token and returns its principal,
 * such as `user:<sub>`, when it is on the allowlist. */
export async function authenticate(
  request: Request,
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUDIENCE" | "ALLOWED_PRINCIPALS">,
  testKeys?: JWTVerifyGetKey,
): Promise<string> {
  const issuer = env.ACCESS_ISSUER;
  const audience = env.ACCESS_AUDIENCE;
  const allowed = allowedPrincipals(env.ALLOWED_PRINCIPALS);
  if (
    !issuer ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience ||
    audience.length > 256 ||
    !allowed
  )
    throw new HttpError(503, "auth_not_configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) throw new HttpError(401, "authentication_required");
  let keys = testKeys ?? keySets.get(issuer);
  if (!keys) {
    const remote = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
    });
    if (keySets.size >= 4) keySets.clear();
    keySets.set(issuer, remote);
    keys = remote;
  }
  let id: string;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    if (payload["type"] !== "app") throw new Error();
    if (typeof payload.sub === "string" && payload.sub.trim()) id = `user:${payload.sub}`;
    else if (typeof payload["common_name"] === "string" && payload["common_name"].trim())
      id = `service:${payload["common_name"]}`;
    else throw new Error();
  } catch {
    throw new HttpError(401, "authentication_required");
  }
  if (!allowed.has(id)) throw new HttpError(403, "forbidden");
  return id;
}
