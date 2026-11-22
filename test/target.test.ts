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
});
