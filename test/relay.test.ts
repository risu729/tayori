// oxlint-disable no-await-in-loop -- Each request depends on the Relay state the previous one left.
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyResponse, relayStub } from "../src/relay.ts";
import { nextLease, notification, signedRequest } from "./helpers.ts";

const worker = exports.default;
const relay = () => relayStub(env);

async function activate(target: "grok-a" | "grok-b") {
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
  it("answers 404 off the two hosts and paths, and 405 for other methods", async () => {
    for (const url of [
      "https://tayori.takuk.me/",
      "https://tayori.takuk.me/mcp",
      "https://tayori-mcp.takuk.me/in/fumi",
      "https://tayori.takuk.me/in/unknown",
      "https://tayori.example.workers.dev/in/fumi",
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
    await activate("grok-b");
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
    await activate("grok-a");
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
    await activate("grok-a");
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
    await activate("grok-a");
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
    await activate("grok-a");
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
    expect(await relay().setActive("other", "grok-a", nextLease())).toEqual({
      ok: false,
      reason: "unknown_route",
    });
    expect(await relay().setActive("fumi", "grok-c", nextLease())).toEqual({
      ok: false,
      reason: "unknown_target",
    });
    for (const lease of [0, -1, 1.5, Math.floor(Date.now() / 1000) + 2 * 86_400])
      expect(await relay().setActive("fumi", "grok-a", lease)).toEqual({
        ok: false,
        reason: "invalid_lease",
      });
    const lease = nextLease();
    const set = await relay().setActive("fumi", "grok-b", lease);
    expect(set).toMatchObject({ ok: true, source: "fumi", active: "grok-b", leaseUnix: lease });
    expect(await relay().setActive("fumi", "grok-a", lease - 1)).toEqual({
      ok: false,
      reason: "stale_lease",
    });
    expect(await relay().setActive("fumi", "grok-a", lease)).toEqual({
      ok: false,
      reason: "stale_lease",
    });
    expect(await relay().setActive("fumi", "grok-b", lease)).toMatchObject({ ok: true });
    expect(await relay().setActive("fumi", "grok-a", nextLease())).toMatchObject({
      ok: true,
      active: "grok-a",
    });
  });

  it("reports routes without URL paths or keys", async () => {
    await activate("grok-a");
    const routes = await relay().getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ source: "fumi", mode: "one", active: "grok-a" });
    expect(routes[0]!.targets.map((t) => [t.name, t.configured, t.host])).toEqual([
      ["grok-a", true, "grok-a.example.invalid"],
      ["grok-b", true, "grok-b.example.invalid"],
    ]);
    const text = JSON.stringify(routes);
    expect(text).not.toContain("synthetic-key");
    expect(text).not.toContain("/automations/");
  });
});
