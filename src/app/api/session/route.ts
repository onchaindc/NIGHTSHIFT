import { NextRequest, NextResponse } from "next/server";
import {
  OPERATOR_COOKIE,
  expectedOperatorCookieValue,
  operatorCookieFromHeader,
  presentedTokenMatches,
  requestAuthorizedFromParts,
} from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session - operator sign-in for the browser console.
 *
 * The console components run in the browser and must never embed
 * NIGHTSHIFT_API_TOKEN, yet they read full task records that anonymous
 * visitors must not see. The operator pastes the token once into the Settings
 * sign-in card; this route verifies it constant-time against the configured
 * token and sets an HttpOnly session cookie holding a DERIVED verifier —
 * never the token itself. The response carries no secret material.
 *
 * GET /api/session - the CURRENT session from the cookie itself (never the
 * token): { mode: "operator" | "anonymous" | "unavailable" }. The browser
 * uses this to prove the HttpOnly cookie actually stuck after sign-in.
 *
 * DELETE /api/session - sign out (clears the cookie).
 *
 * Both fail closed when no operator token is configured: an unconfigured
 * deployment has no operator, so no session can exist.
 */

const SESSION_MAX_AGE_S = 8 * 60 * 60; // one working day

export async function GET(req: NextRequest) {
  if (!expectedOperatorCookieValue()) return NextResponse.json({ mode: "unavailable" });
  const cookie = operatorCookieFromHeader(req.headers.get("cookie"));
  const authorized = requestAuthorizedFromParts("", cookie);
  return NextResponse.json({ mode: authorized ? "operator" : "anonymous" });
}

export async function POST(req: NextRequest) {
  const expectedCookie = expectedOperatorCookieValue();
  if (!expectedCookie) {
    return NextResponse.json(
      { error: "operator sign-in unavailable: NIGHTSHIFT_API_TOKEN is not configured on this deployment" },
      { status: 401 },
    );
  }
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { token }" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }
  if (!presentedTokenMatches(body.token)) {
    return NextResponse.json({ error: "invalid operator token" }, { status: 401 });
  }
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const res = NextResponse.json({ ok: true, mode: "operator" });
  res.cookies.set(OPERATOR_COOKIE, expectedCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true, mode: "anonymous" });
  res.cookies.set(OPERATOR_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  return res;
}
