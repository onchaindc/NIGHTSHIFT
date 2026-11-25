import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Multi-user production auth: wallet-signed sessions. The operator token
 * remains a server-internal secret; regular users prove ownership of their
 * own wallet with one signature and get an HttpOnly, HMAC-signed cookie.
 */

const TOKEN = "test-server-secret-token";

describe("wallet session auth", () => {
  let buildUserSignInMessage: typeof import("@/lib/api/signInMessage").buildUserSignInMessage;
  let auth: typeof import("@/lib/api/auth");

  beforeEach(async () => {
    vi.stubEnv("NIGHTSHIFT_API_TOKEN", TOKEN);
    ({ buildUserSignInMessage } = await import("@/lib/api/signInMessage"));
    auth = await import("@/lib/api/auth");
    vi.resetModules(); // env must be read fresh by the module under test
    // re-import after reset so userSessionKey() picks up the stubbed env
    auth = await import("@/lib/api/auth");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a session cookie to the same lowercase address", () => {
    const cookie = auth.userSessionCookieValue("0xAbCdEf0123456789aBcDEf0123456789abcDEF01");
    expect(cookie).toContain(".");
    expect(auth.userAddressFromSessionCookie(cookie)).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("rejects a tampered cookie payload", () => {
    const cookie = auth.userSessionCookieValue("0x1111111111111111111111111111111111111111");
    const [payload, sig] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ a: "0x2222222222222222222222222222222222222222", e: Date.now() + 999999 }))
      .toString("base64url");
    expect(auth.userAddressFromSessionCookie(`${forged}.${sig}`)).toBeNull();
    expect(auth.userAddressFromSessionCookie(`${payload}.badsig`)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const cookie = auth.userSessionCookieValue("0x1111111111111111111111111111111111111111", Date.now() - 31 * 24 * 3600 * 1000);
    expect(auth.userAddressFromSessionCookie(cookie)).toBeNull();
  });

  it("binds the sign-in message to its address and a fresh time", () => {
    const now = new Date().toISOString();
    const msg = buildUserSignInMessage("0x1111111111111111111111111111111111111111", now);
    const ok = auth.userSignInMessageValid(msg);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.address).toBe("0x1111111111111111111111111111111111111111");
    // a rewritten template names a DIFFERENT address, which the route must
    // cross-check against the presented address and recovered signer
    const rewritten = auth.userSignInMessageValid(msg.replace("0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"));
    expect(rewritten.ok).toBe(true);
    if (rewritten.ok) expect(rewritten.address).toBe("0x2222222222222222222222222222222222222222");
    // a non-template string must fail
    expect(auth.userSignInMessageValid("please sign this random thing").ok).toBe(false);
    // stale message must fail
    const stale = buildUserSignInMessage("0x1111111111111111111111111111111111111111", new Date(Date.now() - 20 * 60 * 1000).toISOString());
    expect(auth.userSignInMessageValid(stale).ok).toBe(false);
  });

  it("identity resolution: anonymous without cookies, user with a valid cookie", () => {
    const cookie = auth.userSessionCookieValue("0x1111111111111111111111111111111111111111");
    const anon = new Request("http://localhost/api/tasks");
    expect(auth.callerIdentity(anon)).toEqual({ kind: "anonymous" });
    const user = new Request("http://localhost/api/tasks", { headers: { cookie: `ns_user=${cookie}` } });
    expect(auth.callerIdentity(user)).toEqual({ kind: "user", address: "0x1111111111111111111111111111111111111111" });
  });
});

describe("per-user daily spend cap", () => {
  it("blocks a user already at the cap and passes a fresh one", async () => {
    vi.stubEnv("NIGHTSHIFT_API_TOKEN", TOKEN);
    vi.resetModules();
    const store = await import("@/lib/engine/store");
    vi.spyOn(store, "listTasks").mockResolvedValue([
      {
        id: "t1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: "completed",
        goal: "g",
        plan: null,
        events: [],
        spend: { limitUsdCents: 200, spentUsdCents: 200, entries: [{ ts: Date.now(), description: "ask", amountUsdCents: 200, source: "telegraph" }] },
        permissions: { allowedActions: [], requiresApproval: false, maxRetries: 0 },
        criteria: { primaryVerifiedAgainstNodeSignal: false, answerSane: false, answerMaxAgeSeconds: 0, ownPaymentSettledOnChain: false, reconcileLedgerEntries: false },
        result: null,
        error: null,
        origin: { source: "web" },
        owner: "0xaaa0000000000000000000000000000000000001",
      },
    ] as never);
    const { paidRunGate, userPaidSpend24h } = await import("@/lib/api/userSpend");

    const standing = await userPaidSpend24h("0xAAA0000000000000000000000000000000000001");
    expect(standing.spentCents).toBe(200);
    expect(standing.allowsAdditional(0)).toBe(true); // a genuinely free run fits
    expect(standing.allowsAdditional(1)).toBe(false); // but anything costing a cent does not
    expect(standing.allowsAdditional(50)).toBe(false);

    const req = new Request("http://localhost/api/mind/x", { headers: { cookie: `ns_user=${(await import("@/lib/api/auth")).userSessionCookieValue("0xAAA0000000000000000000000000000000000001")}` } });
    const gate = await paidRunGate(req, "intel runs");
    expect(gate.kind).toBe("deny"); // already at the $2 daily cap
    if (gate.kind === "deny") expect(gate.status).toBe(403);

    const fresh = await userPaidSpend24h("0xbbb0000000000000000000000000000000000001");
    expect(fresh.spentCents).toBe(0);
  });
});
