import { DurableObject } from "cloudflare:workers";
import { LIMITS, ROUTES, TARGETS, lookup } from "./config.ts";
import { parseTarget } from "./target.ts";

/** What the source is told: 200 for `forwarded`, 503 (retry) for anything else. */
export type DeliveryResult = "forwarded" | "retry";

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
interface TargetRow extends Record<string, SqlStorageValue> {
  target: string;
  status: string;
  reason: string;
  at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS target_status(
      target TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  private route(source: string): RouteRow | undefined {
    return this.sql
      .exec<RouteRow>(`SELECT active, lease_unix, set_at FROM routes WHERE route = ?`, source)
      .toArray()[0];
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

    const route = lookup(ROUTES, source);
    const active = this.route(source);
    const target = active && route?.targets.includes(active.active) ? active.active : null;
    const log = (fields: Record<string, unknown>) =>
      console.log(
        JSON.stringify({
          event: "forward",
          source,
          target,
          setAgeSeconds: active ? Math.round((now - active.set_at) / 1000) : null,
          ...fields,
        }),
      );
    if (!target) {
      log({ outcome: "unavailable", reason: "no_active_target" });
      return "retry";
    }
    const config = lookup(TARGETS, target);
    const endpoint = config ? parseTarget(this.env[config.secret]) : null;
    if (!endpoint) {
      this.noteTarget(target, "config_error", "target_not_configured", now);
      log({ outcome: "unavailable", reason: "target_not_configured" });
      return "retry";
    }

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

    let outcome: Outcome;
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.key}`,
          "webhook-id": webhookId,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(LIMITS.forwardTimeoutMs),
      });
      await response.body?.cancel();
      outcome = classifyResponse(response.status);
    } catch (error) {
      // A timeout may fire after the target received the request; anything
      // else failed before a response and is safe to resend.
      outcome =
        error instanceof DOMException && error.name === "TimeoutError"
          ? { state: "unknown", reason: "timeout" }
          : { state: "cleared", status: null, reason: "network_error" };
    }

    const done = Date.now();
    try {
      if (outcome.state === "forwarded")
        this.sql.exec(
          `UPDATE deliveries SET state = 'forwarded', lock_until = 0, updated_at = ?
           WHERE source = ? AND webhook_id = ?`,
          done,
          source,
          webhookId,
        );
      else if (outcome.state === "unknown")
        this.sql.exec(
          `UPDATE deliveries SET state = 'unknown', lock_until = 0, updated_at = ?
           WHERE source = ? AND webhook_id = ?`,
          done,
          source,
          webhookId,
        );
      else
        this.sql.exec(
          `DELETE FROM deliveries WHERE source = ? AND webhook_id = ?`,
          source,
          webhookId,
        );
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
    return Object.entries(ROUTES).map(([source, route]) => {
      const row = this.route(source);
      return {
        source,
        mode: route.mode,
        active: row?.active ?? null,
        leaseUnix: row?.lease_unix ?? null,
        setAt: row ? iso(row.set_at) : null,
        setAgeSeconds: row ? Math.round((now - row.set_at) / 1000) : null,
        targets: route.targets.map((name) => {
          const config = lookup(TARGETS, name);
          const endpoint = config ? parseTarget(this.env[config.secret]) : null;
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
      };
    });
  }
}

/** The single Relay instance. cf infers the self-referencing binding without its
 * class, so the RPC type is restated here. */
export function relayStub(env: Env): DurableObjectStub<Relay> {
  return (env.RELAY as DurableObjectNamespace as DurableObjectNamespace<Relay>).getByName("relay");
}
