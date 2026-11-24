import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/session/route";
import { expectedOperatorCookieValue, presentedTokenMatches } from "@/lib/api/auth";

const ORIGINAL = process.env.NIGHTSHIFT_API_TOKEN;

function sessionRequest(init?: { cookie?: string }) {
  return new NextRequest("http://localhost/api/session", {
    headers: init?.cookie ? { cookie: init.cookie } : undefined,
  });
}

describe("operator token comparison", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL;
  });

  it("tolerates whitespace copied with the token on either side", () => {
    process.env.NIGHTSHIFT_API_TOKEN = "  s3cret-token\n";
    // The value pasted from a phone/dashboard often carries whitespace.
    expect(presentedTokenMatches("s3cret-token")).toBe(true);
    expect(presentedTokenMatches(" s3cret-token ")).toBe(true);
    expect(presentedTokenMatches("s3cret-token\n")).toBe(true);
    expect(presentedTokenMatches("wrong")).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    expect(presentedTokenMatches("anything")).toBe(false);
    expect(expectedOperatorCookieValue()).toBe("");
  });
});

describe("GET /api/session", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "session-test-token";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL;
  });

  it("reports anonymous without a cookie", async () => {
    const res = await GET(sessionRequest());
    expect(await res.json()).toEqual({ mode: "anonymous" });
  });

  it("reports operator for the derived cookie and anonymous for a forged one", async () => {
    const cookie = expectedOperatorCookieValue();
    const ok = await GET(sessionRequest({ cookie: `ns_operator=${cookie}` }));
    expect(await ok.json()).toEqual({ mode: "operator" });

    const forged = await GET(sessionRequest({ cookie: "ns_operator=deadbeef" }));
    expect(await forged.json()).toEqual({ mode: "anonymous" });
  });

  it("reports unavailable when no operator token is configured", async () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    const res = await GET(sessionRequest());
    expect(await res.json()).toEqual({ mode: "unavailable" });
  });
});

describe("POST /api/session", () => {
  beforeEach(() => {
    process.env.NIGHTSHIFT_API_TOKEN = "session-test-token";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
    else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL;
  });

  it("sets the HttpOnly session cookie for a trimmed valid token", async () => {
    const req = new NextRequest("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "  session-test-token \n" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ns_operator=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("rejects a wrong token without a cookie", async () => {
    const req = new NextRequest("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
