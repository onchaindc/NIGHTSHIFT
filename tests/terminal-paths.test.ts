import { describe, expect, it } from "vitest";

import { normalizeAskPath } from "@/lib/terminal/paths";

describe("terminal ask path allowlist", () => {
  it("accepts the ask root and one miner segment", () => {
    expect(normalizeAskPath("/engine/v1/ask")).toBe("/engine/v1/ask");
    expect(normalizeAskPath("/engine/v1/ask/TxLens")).toBe("/engine/v1/ask/TxLens");
  });

  it("rejects traversal, extra segments, and query or fragment markers", () => {
    expect(normalizeAskPath("/engine/v1/ask/../admin")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/%2e%2e/admin")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/%2E%2E")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo/bar")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo%2Fbar")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo%5Cbar")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo?x=1")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo#fragment")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/foo%20bar")).toBeNull();
  });

  it("rejects unrelated or malformed values", () => {
    expect(normalizeAskPath(undefined)).toBeNull();
    expect(normalizeAskPath(null)).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask-anything")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/")).toBeNull();
    expect(normalizeAskPath("/engine/v1/ask/%E0%A4%A")).toBeNull();
  });
});
