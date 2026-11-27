import { describe, expect, it } from "vitest";

import { ACP_OFFERINGS, validateRequirement } from "@/lib/acp/offerings";
import {
  JOURNEY_STEPS,
  journeyStep,
  missingRequired,
  preflightBlocking,
  preflightChecks,
  usableSamples,
  MIN_GAS_WEI,
} from "@/lib/acp/buyer-stages";

/**
 * The buyer journey's pure contract: the six visible stages, the gate
 * between them, the sample values that must satisfy every offering's real
 * schema, and the preflight that blocks a signature before the wallet
 * would ever be asked for one.
 */

describe("the journey stepper", () => {
  it("orders the six stages the desk promises: Storefront → Configure → Review → Payment → Tracking → Deliverable", () => {
    expect(JOURNEY_STEPS).toEqual(["Storefront", "Configure", "Review", "Payment", "Tracking", "Deliverable"]);
  });

  it("maps desk stages to journey steps", () => {
    expect(journeyStep("storefront", null)).toBe(1);
    expect(journeyStep("configure", null)).toBe(2);
    expect(journeyStep("review", null)).toBe(3);
  });

  it("maps the job's real lifecycle onto Payment / Tracking / Deliverable", () => {
    expect(journeyStep("tracking", "submitted")).toBe(4); // priced next → payment
    expect(journeyStep("tracking", "reading")).toBe(4);
    expect(journeyStep("tracking", "awaiting_payment")).toBe(4);
    expect(journeyStep("tracking", "processing")).toBe(5);
    expect(journeyStep("tracking", "review_delivery")).toBe(6);
    expect(journeyStep("tracking", "completed")).toBe(6);
    expect(journeyStep("tracking", "failed")).toBe(5);
    expect(journeyStep("history", null)).toBe(5);
  });
});

describe("the configure gate", () => {
  it("names exactly the missing required fields, and passes once they are filled", () => {
    for (const offering of ACP_OFFERINGS) {
      const required = offering.inputs.filter((f) => f.required).map((f) => f.label);
      expect(missingRequired(offering, {})).toEqual(required);
      const filled = Object.fromEntries(offering.inputs.filter((f) => f.required).map((f) => [f.name, "x"]));
      expect(missingRequired(offering, filled)).toEqual([]);
    }
  });
});

describe("sample values must satisfy the real input schema", () => {
  it("every offering's samples fill ONLY known fields and pass validation", () => {
    for (const offering of ACP_OFFERINGS) {
      expect(Object.keys(offering.samples).length).toBeGreaterThan(0);
      const known = new Set(offering.inputs.map((f) => f.name));
      for (const key of Object.keys(offering.samples)) {
        expect(known.has(key), `${offering.id} sample field "${key}" is not in the schema`).toBe(true);
      }
      const validation = validateRequirement(offering, offering.samples);
      expect(validation.ok, `${offering.id} samples must pass the offering's own validation: ${validation.error}`).toBe(true);
    }
  });

  it("usableSamples never invents fields and never drops a required one", () => {
    for (const offering of ACP_OFFERINGS) {
      const usable = usableSamples(offering, offering.samples);
      const known = new Set(offering.inputs.map((f) => f.name));
      for (const key of Object.keys(usable)) expect(known.has(key)).toBe(true);
      for (const field of offering.inputs.filter((f) => f.required)) {
        expect(usable[field.name], `${offering.id} required ${field.name} must exist after fill`).toBeDefined();
      }
      // A stray sample key is filtered out, not submitted.
      const polluted = usableSamples(offering, { ...offering.samples, hacker_controlled_field: "x" });
      expect(polluted.hacker_controlled_field).toBeUndefined();
    }
  });
});

describe("preflight — the reads before any signature", () => {
  const price = 200_000_000n; // $200 USDC, base units

  it("blocks on a wallet that is not on Base", () => {
    const checks = preflightChecks({
      walletChainId: 1,
      requiredChainId: 8453,
      gasWei: 10n ** 16n,
      usdcBase: price,
      priceBase: price,
      allowanceBase: price,
    });
    const chain = checks.find((c) => c.id === "wallet_chain");
    expect(chain?.state).toBe("block");
    expect(chain?.detail).toContain("chain 1");
    expect(preflightBlocking(checks)).toBe(true);
  });

  it("blocks on zero gas — and warns (never blocks) on a low but non-zero balance", () => {
    const zero = preflightChecks({ walletChainId: 8453, requiredChainId: 8453, gasWei: 0n, usdcBase: price, priceBase: price, allowanceBase: price });
    expect(zero.find((c) => c.id === "gas")?.state).toBe("block");
    expect(preflightBlocking(zero)).toBe(true);

    const low = preflightChecks({ walletChainId: 8453, requiredChainId: 8453, gasWei: MIN_GAS_WEI - 1n, usdcBase: price, priceBase: price, allowanceBase: price });
    expect(low.find((c) => c.id === "gas")?.state).toBe("warn");
    expect(preflightBlocking(low)).toBe(false);
  });

  it("blocks on USDC below the price", () => {
    const checks = preflightChecks({ walletChainId: 8453, requiredChainId: 8453, gasWei: 10n ** 16n, usdcBase: price - 1n, priceBase: price, allowanceBase: price });
    expect(checks.find((c) => c.id === "usdc")?.state).toBe("block");
    expect(preflightBlocking(checks)).toBe(true);
  });

  it("a short allowance is a to-do, not a blocker — the payment step requests it", () => {
    const checks = preflightChecks({ walletChainId: 8453, requiredChainId: 8453, gasWei: 10n ** 16n, usdcBase: price, priceBase: price, allowanceBase: 0n });
    expect(checks.find((c) => c.id === "allowance")?.state).toBe("ok");
    expect(checks.find((c) => c.id === "allowance")?.detail).toContain("approval");
    expect(preflightBlocking(checks)).toBe(false);
  });

  it("all-clear reads as all-clear", () => {
    const checks = preflightChecks({ walletChainId: 8453, requiredChainId: 8453, gasWei: 10n ** 17n, usdcBase: price, priceBase: price, allowanceBase: price });
    expect(checks.every((c) => c.state === "ok")).toBe(true);
    expect(preflightBlocking(checks)).toBe(false);
  });

  it("an unread wallet chain blocks — signing waits for certainty", () => {
    const checks = preflightChecks({ walletChainId: null, requiredChainId: 8453, gasWei: 10n ** 17n, usdcBase: price, priceBase: price, allowanceBase: price });
    expect(preflightBlocking(checks)).toBe(true);
  });
});
