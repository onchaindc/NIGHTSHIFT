import { describe, expect, it } from "vitest";

import { createQueryChain } from "@/lib/db/client";

/**
 * The shared database client runs every query through this chain. The
 * regression it pins: concurrent queries can never over-subscribe the pool —
 * against the pooled upstream, a queued query has been observed to wait for a
 * connection that is never handed over, which hung /overview forever (three
 * parallel store reads) while every single-query route answered in under a
 * second. One query in flight per runtime makes that state impossible.
 */
describe("createQueryChain — queries run one at a time", () => {
  it("never runs two works concurrently, however many are submitted", async () => {
    const chain = createQueryChain();
    let inFlight = 0;
    let maxInFlight = 0;
    const work = async (value: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    };
    const results = await Promise.all([
      chain.run(() => work(1)),
      chain.run(() => work(2)),
      chain.run(() => work(3)),
      chain.run(() => work(4)),
      chain.run(() => work(5)),
    ]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(1);
  });

  it("a rejected work does not stall the chain", async () => {
    const chain = createQueryChain();
    await expect(chain.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(chain.run(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("every caller still receives its own result and error", async () => {
    const chain = createQueryChain();
    const outcomes = await Promise.allSettled([
      chain.run(() => Promise.resolve("a")),
      chain.run(() => Promise.reject(new Error("middle"))),
      chain.run(() => Promise.resolve("c")),
    ]);
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[2]).toEqual({ status: "fulfilled", value: "c" });
  });
});
