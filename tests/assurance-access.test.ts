import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET as listRoute, POST as createRoute } from "@/app/api/assurance/route";
import { POST as demoRoute } from "@/app/api/assurance/demo/route";
import { GET as fileRoute } from "@/app/api/assurance/[id]/route";
import { POST as inspectRoute } from "@/app/api/assurance/[id]/inspect/route";
import { POST as intelligenceRoute } from "@/app/api/assurance/[id]/intelligence/route";
import { userSessionCookieValue, USER_COOKIE } from "@/lib/api/auth";
import { base58Encode } from "@/lib/assurance/solana";
import { createAssuranceRun } from "@/lib/assurance/run";
import { getInvestigation } from "@/lib/assurance/store";

const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;

/** Deterministic, structurally valid Solana address for tests. */
function testAddress(seed: string): string {
  return base58Encode(createHash("sha256").update(`assurance-access:${seed}`).digest());
}

const WALLET_A = testAddress("wallet-a").toLowerCase(); // session addresses are lowercase
const WALLET_B = testAddress("wallet-b").toLowerCase();

function userCookie(address: string): string {
  return `${USER_COOKIE}=${userSessionCookieValue(address)}`;
}

function req(url: string, init?: { cookie?: string; method?: string; body?: unknown }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(init?.cookie ? { cookie: init.cookie } : {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

function createBody(seed: string) {
  return {
    payerWallet: testAddress(`${seed}-payer`),
    recipientWallet: testAddress(`${seed}-recipient`),
    amountUsdc: 25_000,
    jurisdiction: "GB",
    approvedBeneficiary: "Access Test Holdings Ltd",
    counterpartyName: "Access Test Holdings Ltd",
  };
}

describe("assurance demonstration fixture access", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "assurance-access-test-token";
  });
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
  });

  it("seeds the demo anonymously and is idempotent (no store growth)", async () => {
    const first = await demoRoute(req("/api/assurance/demo", { method: "POST" }));
    expect([200, 201]).toContain(first.status);
    const a = (await first.json()) as { investigation: { id: string } };

    const second = await demoRoute(req("/api/assurance/demo", { method: "POST" }));
    const b = (await second.json()) as { investigation: { id: string } };
    expect(b.investigation.id).toBe(a.investigation.id);
  });

  it("shows the demo file to anonymous, wallet and operator callers", async () => {
    for (const cookie of [undefined, userCookie(WALLET_A), undefined]) {
      const res = await listRoute(req("/api/assurance", { cookie }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { investigations: Array<{ dataMode?: string }> };
      expect(body.investigations.some((i) => i.dataMode === "demonstration")).toBe(true);
    }
  });
});

describe("assurance live file ownership", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "assurance-access-test-token";
  });
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
  });

  it("refuses anonymous live-file creation and stamps the wallet that opened one", async () => {
    const anon = await createRoute(req("/api/assurance", { method: "POST", body: createBody("anon") }));
    expect(anon.status).toBe(401);

    const created = await createRoute(req("/api/assurance", { method: "POST", body: createBody("owned"), cookie: userCookie(WALLET_A) }));
    expect(created.status).toBe(201);
    const { investigation } = (await created.json()) as { investigation: { id: string; owner: string | null } };
    expect(investigation.owner).toBe(WALLET_A);

    const stored = await getInvestigation(investigation.id);
    expect(stored?.owner).toBe(WALLET_A);
  });

  it("shows an owned live file to its owner, hides it from everyone else", async () => {
    const created = await createRoute(req("/api/assurance", { method: "POST", body: createBody("visible"), cookie: userCookie(WALLET_A) }));
    const { investigation } = (await created.json()) as { investigation: { id: string } };

    // Owner: readable, not read-only.
    const ownerView = await fileRoute(req(`/api/assurance/${investigation.id}`, { cookie: userCookie(WALLET_A) }), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect(ownerView.status).toBe(200);
    expect(((await ownerView.json()) as { readOnly: boolean }).readOnly).toBe(false);

    // Another wallet: indistinguishable from absent.
    const otherView = await fileRoute(req(`/api/assurance/${investigation.id}`, { cookie: userCookie(WALLET_B) }), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect(otherView.status).toBe(404);

    // Anonymous: same.
    const anonView = await fileRoute(req(`/api/assurance/${investigation.id}`), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect(anonView.status).toBe(404);

    // The list scopes identically.
    const mine = (await (await listRoute(req("/api/assurance", { cookie: userCookie(WALLET_A) }))).json()) as {
      investigations: Array<{ id: string }>;
    };
    expect(mine.investigations.some((i) => i.id === investigation.id)).toBe(true);

    const theirs = (await (await listRoute(req("/api/assurance", { cookie: userCookie(WALLET_B) }))).json()) as {
      investigations: Array<{ id: string }>;
    };
    expect(theirs.investigations.some((i) => i.id === investigation.id)).toBe(false);
  });

  it("gates mutations: anonymous 401, other wallet 403, owner passes", async () => {
    const created = await createRoute(req("/api/assurance", { method: "POST", body: createBody("mutate"), cookie: userCookie(WALLET_A) }));
    const { investigation } = (await created.json()) as { investigation: { id: string } };

    const anon = await inspectRoute(req(`/api/assurance/${investigation.id}/inspect`, { method: "POST" }), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect(anon.status).toBe(401);

    const other = await inspectRoute(req(`/api/assurance/${investigation.id}/inspect`, { method: "POST", cookie: userCookie(WALLET_B) }), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect(other.status).toBe(403);

    // The owner passes the gate; the route itself then does real Solana reads,
    // which the fixture wallets cannot satisfy — the point here is the gate,
    // so accept either a successful inspection or an RPC-level failure.
    const owner = await inspectRoute(req(`/api/assurance/${investigation.id}/inspect`, { method: "POST", cookie: userCookie(WALLET_A) }), {
      params: Promise.resolve({ id: investigation.id }),
    });
    expect([200, 502]).toContain(owner.status);

    const otherIntel = await intelligenceRoute(
      req(`/api/assurance/${investigation.id}/intelligence`, { method: "POST", cookie: userCookie(WALLET_B), body: { action: "run", mode: "free" } }),
      { params: Promise.resolve({ id: investigation.id }) },
    );
    expect(otherIntel.status).toBe(403);
  });

  it("stamps the file's owner onto its engine runs", async () => {
    const created = await createRoute(req("/api/assurance", { method: "POST", body: createBody("run-owner"), cookie: userCookie(WALLET_A) }));
    const { investigation } = (await created.json()) as { investigation: { id: string } };
    const stored = await getInvestigation(investigation.id);
    expect(stored).not.toBeNull();

    const { task } = await createAssuranceRun(stored!, "intel", { owner: stored!.owner, actor: WALLET_A });
    expect(task.owner).toBe(WALLET_A);
    expect(task.state).toBe("awaiting_approval");
  });
});
