import { DurableObject } from "cloudflare:workers";
import {
  HANDOFF_ID,
  LIMITS,
  ROUTES,
  SOURCES,
  TARGETS,
  lookup,
  type TargetConfig,
} from "./config.ts";
import { parseTarget, type TargetEndpoint } from "./target.ts";

/** What the source is told: 200 for `forwarded`, 503 (retry) for anything else. */
export type DeliveryResult = "forwarded" | "retry";

/** What `fire` tells the MCP caller. Only `forwarded` means the receiver was woken
 * now; the caller never retries `unknown` or `already_forwarded`. */
export type FireResult =
  | { status: "forwarded" }
  | { status: "already_forwarded"; firstAt: string }
  | {
      error: "unknown_source" | "invalid_arguments" | "rate_limited" | "unavailable" | "unknown";
    };

export type SetActiveResult =
  | { ok: true; source: string; active: string; leaseUnix: number; setAt: string }
  | { ok: false; reason: "unknown_route" | "unknown_target" | "invalid_lease" | "stale_lease" };

export interface RouteStatus {
  source: string;
  mode: "one";
  active: string | null;
  leaseUnix: number | null;
  setAt: string | null;
  setAgeSeconds: number | null;
  targets: {
    name: string;
    configured: boolean;
    host: string | null;
    lastStatus: string | null;
    lastReason: string | null;
    lastAt: string | null;
  }[];
  /** For an `mcp` source: sends left in the rolling hour and day. */
  fire?: {
    perHour: number;
    perDay: number;
    leftHour: number;
    leftDay: number;
    lastRateLimitedAt: string | null;
  };
}

type Outcome =
  | { state: "forwarded"; status: number }
  | { state: "cleared"; status: number | null; reason: string }
  | { state: "unknown"; reason: string };

/** The 2xx/429/3xx/5xx/other-4xx split in docs/design.md. */
export function classifyResponse(status: number): Outcome {
  if (status >= 200 && status < 300) return { state: "forwarded", status };
  if (status === 429 || (status >= 300 && status < 400) || status >= 500)
    return { state: "cleared", status, reason: "target_unavailable" };
  return { state: "cleared", status, reason: "target_rejected" };
}

interface DeliveryRow extends Record<string, SqlStorageValue> {
  state: string;
  lock_until: number;
}
interface RouteRow extends Record<string, SqlStorageValue> {
  active: string;
  lease_unix: number;
  set_at: number;
}
interface CountRow extends Record<string, SqlStorageValue> {
  hour: number;
  day: number;
}
interface TargetRow extends Record<string, SqlStorageValue> {
  target: string;
  status: string;
  reason: string;
  at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Resolved {
  target: string;
  config: TargetConfig;
  endpoint: TargetEndpoint;
}

/** POSTs to a target with its authentication and records nothing. */
async function post(
  resolved: Resolved,
  webhookId: string,
  body: Uint8Array<ArrayBuffer> | string,
): Promise<Outcome> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolved.endpoint.key}`,
  };
  if (resolved.config.auth === "claude-routine") {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "experimental-cc-routine-2026-04-01";
  } else {
    // Only bearer receivers use the id; it is not sent to a third-party API.
    headers["webhook-id"] = webhookId;
  }
  try {
    const response = await fetch(resolved.endpoint.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(resolved.config.timeoutMs ?? LIMITS.forwardTimeoutMs),
    });
    await response.body?.cancel();
    return classifyResponse(response.status);
  } catch (error) {
    // A timeout may fire after the target received the request; anything
    // else failed before a response and is safe to resend.
    return error instanceof DOMException && error.name === "TimeoutError"
      ? { state: "unknown", reason: "timeout" }
      : { state: "cleared", status: null, reason: "network_error" };
  }
}

/** One instance (named "relay") holds every route, delivery record and target status. */
export class Relay extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries(
      source TEXT NOT NULL, webhook_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sending','forwarded','unknown')),
      target TEXT NOT NULL, lock_until INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, webhook_id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS deliveries_updated ON deliveries(updated_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS routes(
      route TEXT PRIMARY KEY, active TEXT NOT NULL, lease_unix INTEGER NOT NULL,
      set_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fires(
      source TEXT NOT NULL, webhook_id TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (source, webhook_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS source_status(
      source TEXT PRIMARY KEY, rate_limited_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS target_status(
      target TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  private route(source: string): RouteRow | undefined {
    return this.sql
      .exec<RouteRow>(`SELECT active, lease_unix, set_at FROM routes WHERE route = ?`, source)
      .toArray()[0];
  }

  /** The route's target: the active one, or the only one a single-target route lists. */
  private activeTarget(source: string): { target: string | null; setAt: number | null } {
    const route = lookup(ROUTES, source);
    if (!route) return { target: null, setAt: null };
    const active = this.route(source);
    if (active)
      return {
        target: route.targets.includes(active.active) ? active.active : null,
        setAt: active.set_at,
      };
    return { target: route.targets.length === 1 ? route.targets[0]! : null, setAt: null };
  }

  private resolve(target: string): Resolved | null {
    const config = lookup(TARGETS, target);
    const endpoint = config ? parseTarget(this.env[config.secret], config.auth) : null;
    return config && endpoint ? { target, config, endpoint } : null;
  }

  /** Saves a send's outcome; a cleared send loses its delivery row and its fire slot. */
  private record(
    source: string,
    webhookId: string,
    target: string,
    outcome: Outcome,
    done: number,
  ): void {
    if (outcome.state === "forwarded" || outcome.state === "unknown")
      this.sql.exec(
        `UPDATE deliveries SET state = ?, lock_until = 0, updated_at = ?
         WHERE source = ? AND webhook_id = ?`,
        outcome.state,
        done,
        source,
        webhookId,
      );
    else {
      this.sql.exec(
        `DELETE FROM deliveries WHERE source = ? AND webhook_id = ?`,
        source,
        webhookId,
      );
      this.sql.exec(`DELETE FROM fires WHERE source = ? AND webhook_id = ?`, source, webhookId);
    }
    this.noteTarget(
      target,
      outcome.state === "forwarded"
        ? String(outcome.status)
        : outcome.state === "unknown"
          ? "unknown"
          : String(outcome.status ?? "network_error"),
      outcome.state === "forwarded" ? "forwarded" : outcome.reason,
      done,
    );
  }

  private markSending(source: string, webhookId: string, target: string, now: number): void {
    this.sql.exec(
      `INSERT INTO deliveries(source, webhook_id, state, target, lock_until, updated_at)
       VALUES (?, ?, 'sending', ?, ?, ?)
       ON CONFLICT(source, webhook_id) DO UPDATE SET state = 'sending', target = excluded.target,
       lock_until = excluded.lock_until, updated_at = excluded.updated_at`,
      source,
      webhookId,
      target,
      now + LIMITS.sendingLockMs,
      now,
    );
  }

  private fireCounts(source: string, now: number): CountRow {
    return this.sql
      .exec<CountRow>(
        `SELECT COALESCE(SUM(at > ?), 0) AS hour, COUNT(*) AS day FROM fires
         WHERE source = ? AND at > ?`,
        now - HOUR_MS,
        source,
        now - DAY_MS,
      )
      .toArray()[0]!;
  }

  private noteTarget(target: string, status: string, reason: string, now: number): void {
    this.sql.exec(
      `INSERT INTO target_status(target, status, reason, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET status = excluded.status, reason = excluded.reason, at = excluded.at`,
      target,
      status,
      reason,
      now,
    );
  }

  async deliver(
    source: string,
    webhookId: string,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<DeliveryResult> {
    const now = Date.now();
    this.sql.exec(`DELETE FROM deliveries WHERE updated_at < ?`, now - LIMITS.retentionMs);
    const existing = this.sql
      .exec<DeliveryRow>(
        `SELECT state, lock_until FROM deliveries WHERE source = ? AND webhook_id = ?`,
        source,
        webhookId,
      )
      .toArray()[0];
    if (existing?.state === "forwarded") return "forwarded";
    if (existing?.state === "sending" && existing.lock_until > now) return "retry";

    const { target, setAt } = this.activeTarget(source);
    const log = (fields: Record<string, unknown>) =>
      console.log(
        JSON.stringify({
          event: "forward",
          source,
          target,
          setAgeSeconds: setAt === null ? null : Math.round((now - setAt) / 1000),
          ...fields,
        }),
      );
    if (!target) {
      log({ outcome: "unavailable", reason: "no_active_target" });
      return "retry";
    }
    const resolved = this.resolve(target);
    if (!resolved) {
      this.noteTarget(target, "config_error", "target_not_configured", now);
      log({ outcome: "unavailable", reason: "target_not_configured" });
      return "retry";
    }

    this.markSending(source, webhookId, target, now);
    const outcome = await post(resolved, webhookId, body);
    try {
      this.record(source, webhookId, target, outcome, Date.now());
    } catch {
      // A forwarded delivery still answers 200 when saving the record fails.
    }
    log({
      outcome: outcome.state,
      status: "status" in outcome ? outcome.status : null,
      reason: outcome.state === "forwarded" ? null : outcome.reason,
      ...(outcome.state === "cleared" && outcome.reason === "target_rejected"
        ? { configError: true }
        : {}),
    });
    return outcome.state === "forwarded" ? "forwarded" : "retry";
  }

  /** Wakes the receiver of an `mcp` source once per handoff id (docs/design.md). */
  async fire(source: string, handoffId: string): Promise<FireResult> {
    const config = lookup(SOURCES, source);
    if (!config || config.kind !== "mcp") return { error: "unknown_source" };
    if (!HANDOFF_ID.test(handoffId)) return { error: "invalid_arguments" };
    const webhookId = `mcp_${handoffId}`;
    const now = Date.now();
    this.sql.exec(`DELETE FROM deliveries WHERE updated_at < ?`, now - LIMITS.retentionMs);
    this.sql.exec(`DELETE FROM fires WHERE at < ?`, now - DAY_MS);
    const existing = this.sql
      .exec<DeliveryRow & { updated_at: number }>(
        `SELECT state, lock_until, updated_at FROM deliveries WHERE source = ? AND webhook_id = ?`,
        source,
        webhookId,
      )
      .toArray()[0];
    if (existing?.state === "forwarded")
      return { status: "already_forwarded", firstAt: iso(existing.updated_at) };
    if (existing?.state === "sending" && existing.lock_until > now) return { error: "unavailable" };
    // No receiver here has an idempotency key, so a send that may have arrived
    // (`unknown`, or `sending` past its lock) is never repeated.
    if (existing) return { error: "unknown" };

    const { target } = this.activeTarget(source);
    const resolved = target ? this.resolve(target) : null;
    const log = (fields: Record<string, unknown>) =>
      console.log(JSON.stringify({ event: "forward", source, target, ...fields }));
    if (!target || !resolved) {
      if (target) this.noteTarget(target, "config_error", "target_not_configured", now);
      log({
        outcome: "unavailable",
        reason: target ? "target_not_configured" : "no_active_target",
      });
      return { error: "unavailable" };
    }
    const counts = this.fireCounts(source, now);
    if (counts.hour >= config.limit.perHour || counts.day >= config.limit.perDay) {
      this.sql.exec(
        `INSERT INTO source_status(source, rate_limited_at) VALUES (?, ?)
         ON CONFLICT(source) DO UPDATE SET rate_limited_at = excluded.rate_limited_at`,
        source,
        now,
      );
      log({ outcome: "rate_limited" });
      return { error: "rate_limited" };
    }

    // Reserve the slot and the delivery row before awaiting, so concurrent
    // fires cannot both pass the limit or both send the same id.
    this.sql.exec(
      `INSERT INTO fires(source, webhook_id, at) VALUES (?, ?, ?)
       ON CONFLICT(source, webhook_id) DO UPDATE SET at = excluded.at`,
      source,
      webhookId,
      now,
    );
    this.markSending(source, webhookId, target, now);
    // The Relay builds the body; the caller supplies no bytes. A Project routine
    // refuses a body with `text` (docs/design.md), so it gets `{}`.
    const body =
      resolved.config.auth === "claude-routine" ? "{}" : JSON.stringify({ source, handoffId });
    const outcome = await post(resolved, webhookId, body);
    try {
      this.record(source, webhookId, target, outcome, Date.now());
    } catch {
      // The caller still learns the outcome when saving it fails.
    }
    log({
      outcome: outcome.state,
      status: "status" in outcome ? outcome.status : null,
      reason: outcome.state === "forwarded" ? null : outcome.reason,
      ...(outcome.state === "cleared" && outcome.reason === "target_rejected"
        ? { configError: true }
        : {}),
    });
    if (outcome.state === "forwarded") return { status: "forwarded" };
    return { error: outcome.state === "unknown" ? "unknown" : "unavailable" };
  }

  async setActive(source: string, target: string, leaseUnix: number): Promise<SetActiveResult> {
    const route = lookup(ROUTES, source);
    if (!route || route.mode !== "one") return { ok: false, reason: "unknown_route" };
    if (!route.targets.includes(target)) return { ok: false, reason: "unknown_target" };
    const now = Date.now();
    // A lease time is when the caller's lease was recorded: a past unix time in
    // seconds, allowing 5 minutes of clock skew. A future lease would block the
    // real holder's calls as stale until that time.
    if (!Number.isSafeInteger(leaseUnix) || leaseUnix <= 0 || leaseUnix > now / 1000 + 300)
      return { ok: false, reason: "invalid_lease" };
    const current = this.route(source);
    if (
      current &&
      (leaseUnix < current.lease_unix ||
        (leaseUnix === current.lease_unix && target !== current.active))
    )
      return { ok: false, reason: "stale_lease" };
    this.sql.exec(
      `INSERT INTO routes(route, active, lease_unix, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(route) DO UPDATE SET active = excluded.active, lease_unix = excluded.lease_unix,
       set_at = excluded.set_at`,
      source,
      target,
      leaseUnix,
      now,
    );
    return { ok: true, source, active: target, leaseUnix, setAt: iso(now) };
  }

  async getRoutes(): Promise<RouteStatus[]> {
    const now = Date.now();
    const statuses = new Map(
      this.sql
        .exec<TargetRow>(`SELECT target, status, reason, at FROM target_status`)
        .toArray()
        .map((row) => [row.target, row]),
    );
    return Object.entries(ROUTES).map(([source, route]): RouteStatus => {
      const row = this.route(source);
      const config = lookup(SOURCES, source);
      let fire: RouteStatus["fire"];
      if (config?.kind === "mcp") {
        const counts = this.fireCounts(source, now);
        const limited = this.sql
          .exec<{ rate_limited_at: number }>(
            `SELECT rate_limited_at FROM source_status WHERE source = ?`,
            source,
          )
          .toArray()[0];
        fire = {
          perHour: config.limit.perHour,
          perDay: config.limit.perDay,
          leftHour: Math.max(0, config.limit.perHour - counts.hour),
          leftDay: Math.max(0, config.limit.perDay - counts.day),
          lastRateLimitedAt: limited ? iso(limited.rate_limited_at) : null,
        };
      }
      return {
        source,
        mode: route.mode,
        active: this.activeTarget(source).target,
        leaseUnix: row?.lease_unix ?? null,
        setAt: row ? iso(row.set_at) : null,
        setAgeSeconds: row ? Math.round((now - row.set_at) / 1000) : null,
        targets: route.targets.map((name) => {
          const endpoint = this.resolve(name)?.endpoint ?? null;
          const status = statuses.get(name);
          return {
            name,
            configured: endpoint !== null,
            host: endpoint?.url.host ?? null,
            lastStatus: status?.status ?? null,
            lastReason: status?.reason ?? null,
            lastAt: status ? iso(status.at) : null,
          };
        }),
        ...(fire ? { fire } : {}),
      };
    });
  }
}

/** The single Relay instance. cf infers the self-referencing binding without its
 * class, so the RPC type is restated here. */
export function relayStub(env: Env): DurableObjectStub<Relay> {
  return (env.RELAY as DurableObjectNamespace as DurableObjectNamespace<Relay>).getByName("relay");
}
