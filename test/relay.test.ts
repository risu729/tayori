// oxlint-disable no-await-in-loop -- Each request depends on the Relay state the previous one left.
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { handleIngress } from "../src/ingress.ts";
import { ROUTES, SOURCES, TARGETS } from "../src/config.ts";
import { classifyResponse, relayStub } from "../src/relay.ts";
import { nextLease, notification, signedRequest } from "./helpers.ts";

const worker = exports.default;
const relay = () => relayStub(env);

function mcpLimit(source: string) {
  const config = SOURCES[source]!;
  if (config.kind !== "mcp") throw new Error(`${source} is not an mcp source`);
  return config.limit;
}
const grokPerHour = mcpLimit("to-grok").perHour;
const claudeLimit = mcpLimit("to-claude");

/** Records `count` sends of `source` made just now. */
async function seedFires(source: string, count: number) {
  await runInDurableObject(relay(), async (_instance, state) => {
    for (let i = 0; i < count; i++)
      state.storage.sql.exec(
        `INSERT INTO fires(source, webhook_id, at) VALUES (?, ?, ?)`,
        source,
        `mcp_seed-${i}`,
        Date.now(),
      );
  });
}

async function activate(target: "grok-a-inbox" | "grok-b-inbox") {
  const result = await relay().setActive("fumi", target, nextLease());
  expect(result.ok).toBe(true);
}

function mockTarget(respond: (request: Request) => Response | Promise<Response>) {
  const calls: { request: Request; body: string }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    calls.push({ request, body: await request.clone().text() });
    return respond(request);
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing", () => {
  it("answers 404 off the host and its two paths, and 405 for other methods", async () => {
    for (const url of [
      "https://tayori.takuk.me/",
      "https://tayori.takuk.me/in/",
      "https://tayori.takuk.me/mcp/extra",
      "https://tayori.takuk.me/in/fumi/extra",
      "https://tayori.takuk.me:8443/in/fumi",
      "https://tayori.takuk.me/in/unknown",
      "https://tayori.takuk.me/in/to-claude",
      "https://tayori.example.workers.dev/in/fumi",
      "http://tayori.takuk.me/in/fumi",
      "https://tayori-mcp.takuk.me/mcp",
    ]) {
      const response = await worker.fetch(new Request(url, { method: "POST" }));
      expect(response.status, url).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await worker.fetch(new Request("https://tayori.takuk.me/in/fumi"))).status).toBe(405);
  });
});

describe("no active target", () => {
  // Runs before any test in this file sets a target.
  it("answers 503 without sending", async () => {
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    expect((await worker.fetch(await signedRequest(notification()))).status).toBe(503);
    expect(calls).toHaveLength(0);
    expect((await relay().getRoutes())[0]).toMatchObject({ active: null, setAt: null });
  });
});

describe("ingress verification", () => {
  it("rejects a bad signature, an old timestamp, a wrong secret and a missing header", async () => {
    const good = await signedRequest(notification());
    const tampered = new Request(good, { body: notification("mail_other") });
    expect((await worker.fetch(tampered)).status).toBe(401);
    const old = await signedRequest(notification(), {
      timestamp: Math.floor(Date.now() / 1000) - 301,
    });
    expect((await worker.fetch(old)).status).toBe(401);
    const otherSecret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
    expect(
      (await worker.fetch(await signedRequest(notification(), { secret: otherSecret }))).status,
    ).toBe(401);
    const unsigned = new Request(good);
    unsigned.headers.delete("webhook-signature");
    expect((await worker.fetch(unsigned)).status).toBe(401);
  });

  it("rejects a body over 64 KiB before forwarding", async () => {
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    const big = JSON.stringify({
      kind: "notification",
      messageId: "mail_x",
      pad: "a".repeat(65 * 1024),
    });
    expect((await worker.fetch(await signedRequest(big))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("requires fumi bodies to be a notification with a mail_ messageId", async () => {
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    for (const body of [
      JSON.stringify({ kind: "owner", messageId: "mail_test-0001" }),
      JSON.stringify({ kind: "notification", messageId: "sent_test" }),
      JSON.stringify({ kind: "notification" }),
      "not json",
    ]) {
      expect((await worker.fetch(await signedRequest(body))).status, body).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("forwarding", () => {
  it("forwards the exact body with the active target's bearer key, then deduplicates", async () => {
    await activate("grok-b-inbox");
    const { calls } = mockTarget(() => new Response("ok", { status: 200 }));
    const body = notification();
    const request = await signedRequest(body, { id: "op_forward-once" });
    const first = await worker.fetch(request.clone());
    expect(first.status).toBe(200);
    expect(calls).toHaveLength(1);
    const sent = calls[0]!.request;
    expect(sent.url).toBe("https://grok-b.example.invalid/automations/webhook/synthetic-b");
    expect(sent.method).toBe("POST");
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("authorization")).toBe("Bearer synthetic-key-b");
    expect(sent.headers.get("webhook-id")).toBe("op_forward-once");
    expect(sent.headers.get("webhook-signature")).toBeNull();
    expect(calls[0]!.body).toBe(body);
    const again = await worker.fetch(await signedRequest(body, { id: "op_forward-once" }));
    expect(again.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("clears the record on 429, 3xx and 5xx so the next attempt resends", async () => {
    await activate("grok-a-inbox");
    for (const status of [429, 302, 500, 503]) {
      const responses = [new Response(null, { status }), new Response(null, { status: 202 })];
      const { calls } = mockTarget(() => responses.shift()!);
      const id = `op_retry-${status}`;
      expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(503);
      expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(200);
      expect(calls).toHaveLength(2);
      vi.restoreAllMocks();
    }
  });

  it("logs other 4xx as a configuration error and resends later", async () => {
    await activate("grok-a-inbox");
    const log = vi.spyOn(console, "log");
    const responses = [new Response(null, { status: 401 }), new Response(null, { status: 200 })];
    const { calls } = mockTarget(() => responses.shift()!);
    const id = "op_rejected";
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(503);
    const entry = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((line) => line["event"] === "forward" && line["status"] === 401);
    expect(entry).toMatchObject({
      outcome: "cleared",
      reason: "target_rejected",
      configError: true,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-key");
    expect(JSON.stringify(log.mock.calls)).not.toContain("/automations/");
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("records a timeout as unknown and resends on the next attempt", async () => {
    await activate("grok-a-inbox");
    let first = true;
    const { calls } = mockTarget(async (request) => {
      if (!first) return new Response(null, { status: 200 });
      first = false;
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    });
    const id = "op_timeout";
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(503);
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("resends after a network error before any response", async () => {
    await activate("grok-a-inbox");
    let first = true;
    const { calls } = mockTarget(() => {
      if (first) {
        first = false;
        throw new TypeError("Network connection lost");
      }
      return new Response(null, { status: 200 });
    });
    const id = "op_network";
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(503);
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("classifyResponse", () => {
  it("splits responses as the design says", () => {
    expect(classifyResponse(200).state).toBe("forwarded");
    expect(classifyResponse(204).state).toBe("forwarded");
    for (const status of [301, 429, 500, 502, 503, 504])
      expect(classifyResponse(status)).toMatchObject({
        state: "cleared",
        reason: "target_unavailable",
      });
    for (const status of [400, 401, 403, 404, 413, 422])
      expect(classifyResponse(status)).toMatchObject({
        state: "cleared",
        reason: "target_rejected",
      });
  });
});

describe("set_active", () => {
  it("refuses unknown routes and targets, bad leases and older leases", async () => {
    expect(await relay().setActive("other", "grok-a-inbox", nextLease())).toEqual({
      ok: false,
      reason: "unknown_route",
    });
    expect(await relay().setActive("fumi", "grok-c", nextLease())).toEqual({
      ok: false,
      reason: "unknown_target",
    });
    for (const lease of [0, -1, 1.5, Math.floor(Date.now() / 1000) + 2 * 86_400])
      expect(await relay().setActive("fumi", "grok-a-inbox", lease)).toEqual({
        ok: false,
        reason: "invalid_lease",
      });
    const lease = nextLease();
    const set = await relay().setActive("fumi", "grok-b-inbox", lease);
    expect(set).toMatchObject({
      ok: true,
      source: "fumi",
      active: "grok-b-inbox",
      leaseUnix: lease,
    });
    expect(await relay().setActive("fumi", "grok-a-inbox", lease - 1)).toEqual({
      ok: false,
      reason: "stale_lease",
    });
    expect(await relay().setActive("fumi", "grok-a-inbox", lease)).toEqual({
      ok: false,
      reason: "stale_lease",
    });
    expect(await relay().setActive("fumi", "grok-b-inbox", lease)).toMatchObject({ ok: true });
    expect(await relay().setActive("fumi", "grok-a-inbox", nextLease())).toMatchObject({
      ok: true,
      active: "grok-a-inbox",
    });
  });

  it("reports routes without URL paths or keys", async () => {
    await activate("grok-a-inbox");
    const routes = await relay().getRoutes();
    expect(routes.map((route) => route.source)).toEqual(["fumi", "to-claude", "to-grok"]);
    expect(routes[0]).toMatchObject({ source: "fumi", mode: "one", active: "grok-a-inbox" });
    expect(routes[0]!.targets.map((t) => [t.name, t.configured, t.host])).toEqual([
      ["grok-a-inbox", true, "grok-a.example.invalid"],
      ["grok-b-inbox", true, "grok-b.example.invalid"],
    ]);
    expect(routes[1]).toMatchObject({ active: "claude", setAt: null });
    expect(routes[1]!.targets[0]).toMatchObject({ configured: true, host: "api.anthropic.com" });
    expect(routes[1]!.fire).toMatchObject(claudeLimit);
    expect(routes[0]!.fire).toBeUndefined();
    const text = JSON.stringify(routes);
    expect(text).not.toContain("synthetic-key");
    expect(text).not.toContain("/automations/");
    expect(text).not.toContain("/routines/");
  });
});

describe("review cases", () => {
  it("refuses a lease more than 5 minutes in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await relay().setActive("fumi", "grok-a-inbox", now + 301)).toEqual({
      ok: false,
      reason: "invalid_lease",
    });
  });

  it("logs a timeout as unknown", async () => {
    await activate("grok-a-inbox");
    const log = vi.spyOn(console, "log");
    mockTarget(
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    expect(
      (await worker.fetch(await signedRequest(notification(), { id: "op_timeout-log" }))).status,
    ).toBe(503);
    const entry = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((line) => line["event"] === "forward" && line["outcome"] !== undefined);
    expect(entry).toMatchObject({ outcome: "unknown", reason: "timeout" });
  });

  it("answers 503 without a second send while the same delivery is in flight", async () => {
    await activate("grok-a-inbox");
    let released = false;
    // The response is created inside the Relay's own I/O context once released.
    const { calls } = mockTarget(async () => {
      await vi.waitUntil(() => released, { timeout: 2000, interval: 10 });
      return new Response(null, { status: 200 });
    });
    const id = "op_in-flight";
    const first = worker.fetch(await signedRequest(notification(), { id }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((await worker.fetch(await signedRequest(notification(), { id }))).status).toBe(503);
    expect(calls).toHaveLength(1);
    released = true;
    expect((await first).status).toBe(200);
  });

  it("refuses a streamed body over 64 KiB without a Content-Length", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(97);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) controller.close();
        else {
          sent += 1;
          controller.enqueue(chunk);
        }
      },
    });
    const signed = await signedRequest(notification());
    const request = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect((await worker.fetch(request)).status).toBe(413);
  });

  it("refuses a timestamp more than 300 s in the future", async () => {
    const future = await signedRequest(notification(), {
      timestamp: Math.floor(Date.now() / 1000) + 301,
    });
    expect((await worker.fetch(future)).status).toBe(401);
  });

  it("answers 503 when the source secret is missing", async () => {
    const ctx = createExecutionContext();
    const request = await signedRequest(notification());
    await expect(
      handleIngress(request, { ...env, SOURCE_FUMI_SECRET: "not-a-secret" }, ctx, "fumi"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("prunes delivery records older than 7 days", async () => {
    await activate("grok-a-inbox");
    await runInDurableObject(relay(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO deliveries(source, webhook_id, state, target, lock_until, updated_at)
         VALUES ('fumi', 'op_old', 'forwarded', 'grok-a-inbox', 0, ?)`,
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      );
    });
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    expect((await worker.fetch(await signedRequest(notification(), { id: "op_old" }))).status).toBe(
      200,
    );
    // The old record was pruned, so the delivery was sent again.
    expect(calls).toHaveLength(1);
  });
});

describe("fire", () => {
  const resetFires = () =>
    runInDurableObject(relay(), async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM fires`);
    });
  const hang = (request: Request) =>
    new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason));
    });

  it("wakes the Claude routine with an empty body once per handoff id", async () => {
    await resetFires();
    const log = vi.spyOn(console, "log");
    const { calls } = mockTarget(() => new Response('{"claude_code_session_id":"s"}'));
    expect(await relay().fire("to-claude", "desk-20261128-001")).toEqual({
      status: "forwarded",
    });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!.request;
    expect(sent.url).toBe("https://api.anthropic.com/v1/claude_code/routines/trig_synthetic0/fire");
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("authorization")).toBe("Bearer synthetic-key-claude");
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent.headers.get("anthropic-beta")).toBe("experimental-cc-routine-2026-04-01");
    expect(sent.headers.get("webhook-id")).toBeNull();
    expect(calls[0]!.body).toBe("{}");
    expect(await relay().fire("to-claude", "desk-20261128-001")).toMatchObject({
      status: "already_forwarded",
      firstAt: expect.any(String),
    });
    expect(calls).toHaveLength(1);
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain("synthetic-key");
    expect(text).not.toContain("/routines/");
  });

  it("sends Grok a Relay-built body to the active desk target only", async () => {
    await resetFires();
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    expect(await relay().fire("to-grok", "claude-20261128-001")).toEqual({
      error: "unavailable",
    });
    expect(calls).toHaveLength(0);
    expect((await relay().setActive("to-grok", "grok-b-inbox", nextLease())).ok).toBe(false);
    expect((await relay().setActive("to-grok", "grok-b-desk", nextLease())).ok).toBe(true);
    expect(await relay().fire("to-grok", "claude-20261128-001")).toEqual({
      status: "forwarded",
    });
    const sent = calls[0]!.request;
    expect(sent.url).toBe("https://grok-b.example.invalid/automations/webhook/synthetic-b-desk");
    expect(sent.headers.get("authorization")).toBe("Bearer synthetic-key-b-desk");
    expect(sent.headers.get("webhook-id")).toBe("mcp_claude-20261128-001");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      source: "to-grok",
      handoffId: "claude-20261128-001",
    });
  });

  it("refuses webhook sources, unknown sources and ids that are not handoff ids", async () => {
    const { calls } = mockTarget(() => new Response(null, { status: 200 }));
    expect(await relay().fire("fumi", "desk-20261128-002")).toEqual({ error: "unknown_source" });
    expect(await relay().fire("other", "desk-20261128-002")).toEqual({ error: "unknown_source" });
    for (const id of ["", "desk", "desk-2026112-001", "https://x.invalid/", "Desk-20261128-001"])
      expect(await relay().fire("to-claude", id), id).toEqual({ error: "invalid_arguments" });
    expect(calls).toHaveLength(0);
  });

  it("never resends after unknown, but resends after a cleared outcome", async () => {
    await resetFires();
    expect((await relay().setActive("to-grok", "grok-a-desk", nextLease())).ok).toBe(true);
    const timeout = mockTarget(hang);
    expect(await relay().fire("to-grok", "claude-20261128-002")).toEqual({ error: "unknown" });
    expect(await relay().fire("to-grok", "claude-20261128-002")).toEqual({ error: "unknown" });
    expect(timeout.calls).toHaveLength(1);
    vi.restoreAllMocks();
    await resetFires();
    // With all but one hourly slot taken, the retry passes only if the
    // cleared send gave its slot back.
    await seedFires("to-grok", grokPerHour - 1);
    const responses = [new Response(null, { status: 500 }), new Response(null, { status: 200 })];
    const cleared = mockTarget(() => responses.shift()!);
    expect(await relay().fire("to-grok", "claude-20261128-003")).toEqual({
      error: "unavailable",
    });
    expect(await relay().fire("to-grok", "claude-20261128-003")).toEqual({
      status: "forwarded",
    });
    expect(cleared.calls).toHaveLength(2);
  });

  it("limits sends per hour, counting a send in flight, and reports it", async () => {
    await resetFires();
    expect((await relay().setActive("to-grok", "grok-a-desk", nextLease())).ok).toBe(true);
    await seedFires("to-grok", grokPerHour - 1);
    let released = false;
    const { calls } = mockTarget(async () => {
      await vi.waitUntil(() => released, { timeout: 2000, interval: 10 });
      return new Response(null, { status: 200 });
    });
    // The seeded rows and this in-flight send use every hourly slot.
    const first = relay().fire("to-grok", "claude-20261128-004");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await relay().fire("to-grok", "claude-20261128-005")).toEqual({
      error: "rate_limited",
    });
    released = true;
    expect(await first).toEqual({ status: "forwarded" });
    expect(calls).toHaveLength(1);
    const route = (await relay().getRoutes()).find((r) => r.source === "to-grok")!;
    expect(route.fire).toMatchObject({
      perHour: grokPerHour,
      leftHour: 0,
      lastRateLimitedAt: expect.any(String),
    });
  });

  it("answers unavailable without a send while the same id is in flight", async () => {
    await resetFires();
    let released = false;
    const { calls } = mockTarget(async () => {
      await vi.waitUntil(() => released, { timeout: 2000, interval: 10 });
      return new Response(null, { status: 200 });
    });
    const first = relay().fire("to-claude", "desk-20261128-003");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await relay().fire("to-claude", "desk-20261128-003")).toEqual({
      error: "unavailable",
    });
    released = true;
    expect(await first).toEqual({ status: "forwarded" });
    expect(calls).toHaveLength(1);
  });

  it("counts the hour and the day apart and prunes rows older than a day", async () => {
    await resetFires();
    const now = Date.now();
    await runInDurableObject(relay(), async (_instance, state) => {
      for (const [id, at] of [
        ["mcp_seed-2h", now - 2 * 60 * 60 * 1000],
        ["mcp_seed-25h", now - 25 * 60 * 60 * 1000],
      ] as const)
        state.storage.sql.exec(
          `INSERT INTO fires(source, webhook_id, at) VALUES ('to-claude', ?, ?)`,
          id,
          at,
        );
    });
    const before = (await relay().getRoutes()).find((r) => r.source === "to-claude")!;
    expect(before.fire).toMatchObject({
      leftHour: claudeLimit.perHour,
      leftDay: claudeLimit.perDay - 1,
    });
    mockTarget(() => new Response(null, { status: 200 }));
    expect(await relay().fire("to-claude", "desk-20261128-004")).toEqual({
      status: "forwarded",
    });
    const after = (await relay().getRoutes()).find((r) => r.source === "to-claude")!;
    expect(after.fire).toMatchObject({
      leftHour: claudeLimit.perHour - 1,
      leftDay: claudeLimit.perDay - 2,
    });
    await runInDurableObject(relay(), async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(`SELECT webhook_id FROM fires WHERE webhook_id = 'mcp_seed-25h'`)
          .toArray(),
      ).toHaveLength(0);
    });
  });
});

describe("configuration", () => {
  it("gives no target of a webhook route a longer timeout than fumi allows", () => {
    for (const [source, config] of Object.entries(SOURCES)) {
      if (config.kind !== "webhook") continue;
      for (const target of ROUTES[source]!.targets)
        expect(TARGETS[target]!.timeoutMs, target).toBeUndefined();
    }
  });
});
