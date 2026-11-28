import type { TargetConfig } from "./config.ts";

/** A target secret: `{"url":"https://…","key":"…"}`, set by the owner. */
export interface TargetEndpoint {
  url: URL;
  key: string;
}

/** The only URL shape a `claude-routine` target may use. */
const CLAUDE_ROUTINE_HOST = "api.anthropic.com";
const CLAUDE_ROUTINE_PATH = /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{1,128}\/fire$/;

export function parseTarget(
  secret: unknown,
  auth: TargetConfig["auth"] = "bearer",
): TargetEndpoint | null {
  if (typeof secret !== "string" || secret.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(secret);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { url, key } = value as Record<string, unknown>;
    if (typeof url !== "string" || typeof key !== "string") return null;
    // A bearer key is one header value: printable ASCII without spaces.
    if (!/^[\x21-\x7e]{1,1024}$/.test(key)) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
      return null;
    if (
      auth === "claude-routine" &&
      (parsed.hostname !== CLAUDE_ROUTINE_HOST ||
        parsed.port ||
        parsed.search ||
        !CLAUDE_ROUTINE_PATH.test(parsed.pathname))
    )
      return null;
    return { url: parsed, key };
  } catch {
    return null;
  }
}
