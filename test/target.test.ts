import { describe, expect, it } from "vitest";
import { parseTarget } from "../src/target.ts";

describe("parseTarget", () => {
  it("accepts an https URL with a bearer key", () => {
    const target = parseTarget(
      JSON.stringify({ url: "https://a.example.invalid/x/1", key: "k_1" }),
    );
    expect(target?.url.host).toBe("a.example.invalid");
    expect(target?.key).toBe("k_1");
  });
  it("refuses anything else", () => {
    for (const value of [
      undefined,
      "",
      "{not json",
      "[]",
      JSON.stringify({ url: "http://a.example.invalid/", key: "k" }),
      JSON.stringify({ url: "https://user:pw@files.example.com/", key: "k" }),
      JSON.stringify({ url: "https://a.example.invalid/", key: "has space" }),
      JSON.stringify({ url: "https://a.example.invalid/", key: "" }),
      JSON.stringify({ url: "https://a.example.invalid/" }),
    ])
      expect(parseTarget(value), String(value)).toBeNull();
  });

  it("pins claude-routine targets to the routine fire URL", () => {
    const ok = parseTarget(
      JSON.stringify({
        url: "https://api.anthropic.com/v1/claude_code/routines/trig_abc123/fire",
        key: "k_1",
      }),
      "claude-routine",
    );
    expect(ok?.url.pathname).toBe("/v1/claude_code/routines/trig_abc123/fire");
    for (const url of [
      "https://a.example.invalid/v1/claude_code/routines/trig_abc123/fire",
      "https://api.anthropic.com:8443/v1/claude_code/routines/trig_abc123/fire",
      "https://api.anthropic.com/v1/claude_code/routines/trig_abc123/fire?x=1",
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/claude_code/routines/trig_abc123/fire/extra",
      "https://api.anthropic.com/v1/claude_code/routines/../fire",
    ])
      expect(parseTarget(JSON.stringify({ url, key: "k" }), "claude-routine"), url).toBeNull();
  });
});
