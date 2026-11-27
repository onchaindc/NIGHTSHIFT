import { describe, expect, it } from "vitest";

import { readBounded } from "@/lib/api/bounded-read";

/**
 * The Overview page's store reads run under this deadline. The regression it
 * pins: a server-side read that stalls (or fails) must degrade the page to an
 * honest partial view — never hang the RSC stream, which is what kept
 * /overview on its loading state until the platform killed it into the error
 * boundary.
 */
describe("readBounded — a stalled read can never hang a render", () => {
  it("resolves with the value when the read settles in time", async () => {
    await expect(readBounded(Promise.resolve({ ok: 1 }), 1_000)).resolves.toEqual({ ok: 1 });
  });

  it("a rejected read becomes null — never a thrown error past the deadline helper", async () => {
    await expect(readBounded(Promise.reject(new Error("store down")), 1_000)).resolves.toBeNull();
  });

  it("a read that never settles resolves null at the deadline", async () => {
    const started = Date.now();
    const out = await readBounded(new Promise<never>(() => undefined), 25);
    expect(out).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a settled value is not held hostage by the deadline timer", async () => {
    const value = await readBounded(Promise.resolve("fast"), 25);
    expect(value).toBe("fast");
  });
});
