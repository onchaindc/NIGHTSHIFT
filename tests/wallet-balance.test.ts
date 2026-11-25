import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telegraph/client", () => ({
  telegraphPayerAddress: () => "0x1111111111111111111111111111111111111111",
}));

import { GET } from "@/app/api/wallet/balance/route";

describe("GET /api/wallet/balance", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: "0x" + (15_000_000n).toString(16).padStart(64, "0") }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports both payment rails with humanized balances", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payer: string;
      rails: Array<{ chain: string; name: string; balance: { whole: string; atomic: string } | null }>;
    };
    expect(body.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(body.rails).toHaveLength(2);
    const chains = body.rails.map((r) => r.chain);
    expect(chains).toEqual(["Ethereum Sepolia", "Base Sepolia"]);
    for (const rail of body.rails) {
      expect(rail.balance?.whole).toBe("15.000000");
      expect(rail.balance?.atomic).toBe("15000000");
    }
  });

  it("survives a chain read failure instead of lying about the balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const res = await GET();
    const body = (await res.json()) as { rails: Array<{ balance: unknown }> };
    expect(body.rails.every((r) => r.balance === null)).toBe(true);
  });
});
