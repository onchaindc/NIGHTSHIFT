import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/session/route";
import { paidRunGate } from "@/lib/api/userSpend";
import { callerIdentity, isPayerAddress, USER_COOKIE, userSessionCookieValue } from "@/lib/api/auth";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * The payer wallet (TELEGRAPH_EVM_PRIVATE_KEY) IS the deployment operator: it
 * funds every paid run, so a browser session verified to that address must
 * carry operator authority — that is what lets the deployment owner approve
 * operator/agent-created (ownerless) runs without pasting the token.
 */
const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;
const ORIGINAL_KEY = process.env.TELEGRAPH_EVM_PRIVATE_KEY;

const payerKey = generatePrivateKey();
const payerAccount = privateKeyToAccount(payerKey);
const otherKey = generatePrivateKey();
const otherAccount = privateKeyToAccount(otherKey);

beforeEach(() => {
  process.env.NIGHTSHIFT_API_TOKEN = "test-session-secret";
  process.env.TELEGRAPH_EVM_PRIVATE_KEY = payerKey;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
  else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_KEY === undefined) delete process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  else process.env.TELEGRAPH_EVM_PRIVATE_KEY = ORIGINAL_KEY;
});

function walletRequest(address: string): NextRequest {
  const cookie = userSessionCookieValue(address);
  if (!cookie) throw new Error("user session cookie unavailable in test env");
  return new NextRequest("http://localhost/api/session", {
    headers: { cookie: `${USER_COOKIE}=${cookie}` },
  });
}

describe("payer wallet identity", () => {
  it("recognizes the configured payer address only", () => {
    expect(isPayerAddress(payerAccount.address)).toBe(true);
    expect(isPayerAddress(payerAccount.address.toUpperCase())).toBe(true);
    expect(isPayerAddress(otherAccount.address)).toBe(false);
    expect(isPayerAddress(null)).toBe(false);
  });

  it("classifies a payer-wallet session as operator and a stranger as user", async () => {
    const payerRes = await GET(walletRequest(payerAccount.address));
    expect((await payerRes.json()).mode).toBe("operator");
    const otherRes = await GET(walletRequest(otherAccount.address));
    expect((await otherRes.json()).mode).toBe("user");
  });

  it("callerIdentity grants the payer wallet operator authority on task routes", () => {
    expect(callerIdentity(walletRequest(payerAccount.address)).kind).toBe("operator");
    const other = callerIdentity(walletRequest(otherAccount.address));
    expect(other.kind).toBe("user");
  });

  it("paidRunGate lets the payer wallet through as operator; a funded stranger passes, an empty one is refused", async () => {
    const payerGate = await paidRunGate(walletRequest(payerAccount.address), "test runs");
    expect(payerGate.kind).toBe("allow");
    if (payerGate.kind === "allow") expect(payerGate.operator).toBe(true);

    // Paid runs now settle from the user's OWN in-app spend credit: a wallet
    // with credit passes (as a capped user), a wallet without any is refused
    // with the funding instruction.
    const { grantCredits } = await import("@/lib/wallet/credits");
    await grantCredits(otherAccount.address, 100, "test seed");
    const fundedGate = await paidRunGate(walletRequest(otherAccount.address), "test runs");
    expect(fundedGate.kind).toBe("allow");
    if (fundedGate.kind === "allow") expect(fundedGate.operator).toBe(false);

    const emptyKey = generatePrivateKey();
    const emptyAccount = privateKeyToAccount(emptyKey);
    const emptyGate = await paidRunGate(walletRequest(emptyAccount.address), "test runs");
    expect(emptyGate.kind).toBe("deny");
    if (emptyGate.kind === "deny") {
      expect(emptyGate.status).toBe(403);
      expect(emptyGate.error).toMatch(/in-app spend credit/i);
    }
  });
});
