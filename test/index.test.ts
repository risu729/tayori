import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

describe("scaffold Worker", () => {
  it("answers 404 for every request", () => {
    expect(worker.fetch().status).toBe(404);
  });
});
