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

/** A techo handoff id, such as `claude-20261128-001` (techo `bin/handoff`). */
export const HANDOFF_ID = /^[a-z0-9][a-z0-9-]{0,31}-[0-9]{8}-[0-9]{3,4}$/;

type SecretName =
  | "SOURCE_FUMI_SECRET"
  | "TARGET_GROK_A_INBOX"
  | "TARGET_GROK_B_INBOX"
  | "TARGET_GROK_A_DESK"
  | "TARGET_GROK_B_DESK"
  | "TARGET_CLAUDE";

/** A source that POSTs a Standard Webhooks delivery to `/in/<source>`. */
export interface WebhookSourceConfig {
  kind: "webhook";
  /** Worker secret holding the source's Standard Webhooks `whsec_` secret. */
  secret: SecretName;
  bodyCheck?: "fumi-notification";
}
/** A source fired through the MCP tool `fire` with a techo handoff id only. */
export interface McpSourceConfig {
  kind: "mcp";
  payload: "handoff-id";
  /** Sends allowed in a rolling hour and day; a cleared send gives its slot back. */
  limit: { perHour: number; perDay: number };
}
export type SourceConfig = WebhookSourceConfig | McpSourceConfig;

export interface TargetConfig {
  /** `bearer`: any HTTPS URL with `Authorization: Bearer`. `claude-routine`: a
   * claude.ai routine's API fire URL, called with an empty JSON body. */
  auth: "bearer" | "claude-routine";
  /** Worker secret holding `{"url":"https://…","key":"…"}`. */
  secret: SecretName;
  /** Overrides `LIMITS.forwardTimeoutMs`; only for targets no `webhook` source uses. */
  timeoutMs?: number;
}
export interface RouteConfig {
  mode: "one";
  targets: readonly string[];
}

export const SOURCES: Readonly<Record<string, SourceConfig>> = {
  fumi: { kind: "webhook", secret: "SOURCE_FUMI_SECRET", bodyCheck: "fumi-notification" },
  "to-claude": { kind: "mcp", payload: "handoff-id", limit: { perHour: 12, perDay: 50 } },
  "to-grok": { kind: "mcp", payload: "handoff-id", limit: { perHour: 6, perDay: 30 } },
};
export const TARGETS: Readonly<Record<string, TargetConfig>> = {
  "grok-a-inbox": { auth: "bearer", secret: "TARGET_GROK_A_INBOX" },
  "grok-b-inbox": { auth: "bearer", secret: "TARGET_GROK_B_INBOX" },
  "grok-a-desk": { auth: "bearer", secret: "TARGET_GROK_A_DESK" },
  "grok-b-desk": { auth: "bearer", secret: "TARGET_GROK_B_DESK" },
  claude: { auth: "claude-routine", secret: "TARGET_CLAUDE", timeoutMs: 10_000 },
};
/** Each source has exactly one route, named after the source. */
export const ROUTES: Readonly<Record<string, RouteConfig>> = {
  fumi: { mode: "one", targets: ["grok-a-inbox", "grok-b-inbox"] },
  "to-claude": { mode: "one", targets: ["claude"] },
  "to-grok": { mode: "one", targets: ["grok-a-desk", "grok-b-desk"] },
};

export function lookup<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}
