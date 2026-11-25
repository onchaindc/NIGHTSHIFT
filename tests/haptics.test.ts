import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hapticsEnabled, hapticsSupported, setHapticsEnabled, vibrate } from "@/lib/haptics";

describe("haptics", () => {
  const vibrateMock = vi.fn((_p: number | number[]) => true);

  beforeEach(() => {
    vibrateMock.mockClear();
    // Works in node (no navigator) and jsdom alike: replace the whole global.
    vi.stubGlobal("navigator", { vibrate: vibrateMock });
  });

  afterEach(() => {
    setHapticsEnabled(true);
    vi.unstubAllGlobals();
  });

  it("fires distinct patterns per feedback kind", () => {
    vibrate("select");
    vibrate("success");
    vibrate("error");
    vibrate("payment");
    vibrate("notify");
    const calls = vibrateMock.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe(10); // select: a tick
    expect(Array.isArray(calls[1]) && calls[1].length === 3).toBe(true); // success: pulse pair
    expect(calls[2]).not.toEqual(calls[1]); // error must feel different from success
    expect(calls[3]).not.toEqual(calls[0]); // payment must feel different from select
    expect(calls[4]).not.toEqual(calls[2]); // notify distinct from error
  });

  it("respects the user's off switch", () => {
    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
    vibrate("select");
    expect(vibrateMock).not.toHaveBeenCalled();
    setHapticsEnabled(true);
    vibrate("success");
    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the browser has no vibration support (iOS Safari)", () => {
    vi.stubGlobal("navigator", {});
    expect(hapticsSupported()).toBe(false);
    expect(() => vibrate("error")).not.toThrow();
  });
});
