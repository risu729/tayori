/** Deployed relay configuration. Changing it takes a reviewed PR; the active
 * target of a route is runtime state in the Relay Durable Object instead. */

/** Access covers the host; only `/in/*` bypasses it (docs/design.md). */
export const HOST = "tayori.takuk.me";

export const LIMITS = {
  maxBodyBytes: 64 * 1024,
  timestampToleranceSeconds: 300,
  forwardTimeoutMs: 3000,
  sendingLockMs: 60_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

type SecretName = "SOURCE_FUMI_SECRET" | "TARGET_GROK_A" | "TARGET_GROK_B";

export interface SourceConfig {
  /** Worker secret holding the source's Standard Webhooks `whsec_` secret. */
  secret: SecretName;
  bodyCheck?: "fumi-notification";
}
export interface TargetConfig {
  auth: "bearer";
  /** Worker secret holding `{"url":"https://…","key":"…"}`. */
  secret: SecretName;
}
export interface RouteConfig {
  mode: "one";
  targets: readonly string[];
}

export const SOURCES: Readonly<Record<string, SourceConfig>> = {
  fumi: { secret: "SOURCE_FUMI_SECRET", bodyCheck: "fumi-notification" },
};
export const TARGETS: Readonly<Record<string, TargetConfig>> = {
  "grok-a": { auth: "bearer", secret: "TARGET_GROK_A" },
  "grok-b": { auth: "bearer", secret: "TARGET_GROK_B" },
};
/** Each source has exactly one route, named after the source. */
export const ROUTES: Readonly<Record<string, RouteConfig>> = {
  fumi: { mode: "one", targets: ["grok-a", "grok-b"] },
};

export function lookup<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}
