import { env, exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { authenticate } from "../src/access.ts";
import { handleMcp } from "../src/mcp.ts";
import { nextLease } from "./helpers.ts";

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const sign = (claims: Record<string, unknown>, options: { audience?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(env.ACCESS_ISSUER!)
      .setAudience(options.audience ?? env.ACCESS_AUDIENCE!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { verify: createLocalJWKSet({ keys: [jwk] }), sign };
}
const withToken = (token: string) =>
  new Request("https://tayori.takuk.me/mcp", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token },
  });

describe("Access authentication", () => {
  it("accepts an allowed app token and refuses everything else", async () => {
    const { verify, sign } = await keys();
    expect(
      await authenticate(
        withToken(await sign({ type: "app", sub: "synthetic-owner" })),
        env,
        verify,
      ),
    ).toBe("user:synthetic-owner");
    await expect(
      authenticate(withToken(await sign({ type: "app", sub: "someone-else" })), env, verify),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticate(withToken(await sign({ type: "org", sub: "synthetic-owner" })), env, verify),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(
        withToken(await sign({ type: "app", sub: "synthetic-owner" }, { audience: "other" })),
        env,
        verify,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(new Request("https://tayori.takuk.me/mcp"), env, verify),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(withToken("x"), { ...env, ALLOWED_PRINCIPALS: "[]" }, verify),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("guards /mcp on the MCP host", async () => {
    const worker = exports.default;
    expect(
      (await worker.fetch(new Request("https://tayori.takuk.me/mcp", { method: "POST" }))).status,
    ).toBe(401);
    const crossOrigin = new Request("https://tayori.takuk.me/mcp", {
      method: "POST",
      headers: { origin: "https://evil.example.invalid" },
    });
    expect((await worker.fetch(crossOrigin)).status).toBe(403);
    expect(
      (await worker.fetch(new Request("https://tayori.takuk.me/mcp", { method: "PUT" }))).status,
    ).toBe(405);
  });
});

describe("MCP tools", () => {
  it("sets the active target and lists routes through the official client", async () => {
    const client = new Client({ name: "synthetic-agent", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://tayori.takuk.me/mcp"), {
      fetch: async (url, init) =>
        handleMcp(new Request(url, init), env, createExecutionContext(), "user:synthetic-owner"),
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "fire",
        "get_routes",
        "set_active",
      ]);
      const lease = nextLease();
      const set = await client.callTool({
        name: "set_active",
        arguments: { source: "fumi", target: "grok-b", leaseUnix: lease },
      });
      expect(set.isError).not.toBe(true);
      const content = set.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]!.text)).toMatchObject({
        source: "fumi",
        active: "grok-b",
        leaseUnix: lease,
      });
      const stale = await client.callTool({
        name: "set_active",
        arguments: { source: "fumi", target: "grok-a", leaseUnix: lease - 1 },
      });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale.content)).toContain("stale_lease");
      const routes = await client.callTool({ name: "get_routes", arguments: {} });
      const text = (routes.content as { text: string }[])[0]!.text;
      expect(JSON.parse(text).routes[0]).toMatchObject({ source: "fumi", active: "grok-b" });
      expect(text).not.toContain("synthetic-key");
      expect(text).not.toContain("/automations/");
    } finally {
      await client.close();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP fire", () => {
  it("fires an mcp source once and refuses other sources and ids", async () => {
    const calls: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push(new Request(input, init));
      return new Response("{}", { status: 200 });
    });
    const client = new Client({ name: "synthetic-agent", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://tayori.takuk.me/mcp"), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        // Only the MCP request itself goes through the handler unmocked.
        return handleMcp(request, env, createExecutionContext(), "user:synthetic-owner");
      },
    });
    await client.connect(transport);
    try {
      const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
        (result.content as { text: string }[])[0]!.text;
      const first = await client.callTool({
        name: "fire",
        arguments: { source: "to-claude", handoffId: "desk-20261128-101" },
      });
      expect(first.isError).not.toBe(true);
      expect(JSON.parse(text(first))).toEqual({ status: "forwarded" });
      const again = await client.callTool({
        name: "fire",
        arguments: { source: "to-claude", handoffId: "desk-20261128-101" },
      });
      expect(JSON.parse(text(again))).toMatchObject({ status: "already_forwarded" });
      const sends = calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"));
      expect(sends).toHaveLength(1);
      const webhook = await client.callTool({
        name: "fire",
        arguments: { source: "fumi", handoffId: "desk-20261128-102" },
      });
      expect(webhook.isError).toBe(true);
      expect(text(webhook)).toContain("unknown_source");
      const badId = await client.callTool({
        name: "fire",
        arguments: { source: "to-claude", handoffId: "https://evil.example.invalid/" },
      });
      expect(badId.isError).toBe(true);
      expect(text(badId)).toContain("invalid_arguments");
      expect(calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"))).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
