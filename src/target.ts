/** A target secret: `{"url":"https://…","key":"…"}`, set by the owner. */
export interface TargetEndpoint {
  url: URL;
  key: string;
}

export function parseTarget(secret: unknown): TargetEndpoint | null {
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
    return { url: parsed, key };
  } catch {
    return null;
  }
}
