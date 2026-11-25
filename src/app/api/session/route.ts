import { NextRequest, NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import {
  OPERATOR_COOKIE,
  USER_COOKIE,
  USER_SESSION_MAX_AGE_S,
  buildUserSignInMessage,
  expectedOperatorCookieValue,
  operatorCookieFromHeader,
  presentedTokenMatches,
  requestAuthorizedFromParts,
  userAddressFromRequest,
  userAddressFromSessionCookie,
  userSessionCookieValue,
  userSessionsAvailable,
  userSignInMessageValid,
} from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session — sign-in for the browser console, two ways:
 *
 * 1. WALLET (the way every regular user signs in): { address, message,
 *    signature }. The message must be the canonical NIGHTSHIFT sign-in
 *    template (time-bound, explicitly not a transaction); the signature must
 *    recover the claimed address. No shared secret, no token to paste — the
 *    user's own in-app wallet IS the credential. Issues an HttpOnly
 *    HMAC-signed cookie that authenticates the wallet address for 30 days.
 *
 * 2. OPERATOR TOKEN (kept for the deployment owner and programmatic clients):
 *    { token } — verified constant-time against NIGHTSHIFT_API_TOKEN as
 *    before.
 *
 * GET /api/session - the CURRENT session from the cookies themselves (never
 * any secret): { mode: "operator" | "user" | "anonymous" | "unavailable",
 * address? }.
 *
 * DELETE /api/session - sign out (clears both cookies).
 *
 * Wallet sessions fail closed when NIGHTSHIFT_API_TOKEN is unset: without it
 * there is no HMAC key to sign session cookies with, so no session can exist.
 */

const OPERATOR_SESSION_MAX_AGE_S = 8 * 60 * 60; // one working day

export async function GET(req: NextRequest) {
  const operatorAvailable = !!expectedOperatorCookieValue();
  const operatorCookie = operatorCookieFromHeader(req.headers.get("cookie"));
  const operatorOk = requestAuthorizedFromParts("", operatorCookie);
  if (operatorOk) return NextResponse.json({ mode: "operator" });
  const userAddress = userAddressFromRequest(req);
  if (userAddress) return NextResponse.json({ mode: "user", address: userAddress });
  if (!operatorAvailable && !userSessionsAvailable()) {
    return NextResponse.json({ mode: "unavailable" });
  }
  return NextResponse.json({ mode: "anonymous" });
}

export async function POST(req: NextRequest) {
  let body: { token?: unknown; address?: unknown; message?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { token } or { address, message, signature }" }, { status: 400 });
  }

  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

  // Wallet sign-in: verify the signature over the canonical message, then the
  // template itself (shape, address binding, freshness). Order matters — an
  // attacker-controlled message must never be accepted just because it was
  // signed by SOMEONE.
  if (typeof body.address === "string" && typeof body.message === "string" && typeof body.signature === "string") {
    const template = userSignInMessageValid(body.message);
    if (!template.ok) {
      return NextResponse.json({ error: template.reason }, { status: 400 });
    }
    if (template.address.toLowerCase() !== body.address.toLowerCase()) {
      return NextResponse.json({ error: "the signed message names a different address than the one presented" }, { status: 400 });
    }
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: body.message, signature: body.signature as `0x${string}` });
    } catch {
      return NextResponse.json({ error: "the signature could not be verified against this message" }, { status: 401 });
    }
    if (recovered.toLowerCase() !== template.address.toLowerCase()) {
      return NextResponse.json({ error: "the signature does not belong to this wallet" }, { status: 401 });
    }
    const cookie = userSessionCookieValue(recovered);
    if (!cookie) {
      return NextResponse.json(
        { error: "wallet sign-in is unavailable: the deployment has no server secret configured" },
        { status: 503 },
      );
    }
    const res = NextResponse.json({ ok: true, mode: "user", address: recovered.toLowerCase() });
    res.cookies.set(USER_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: USER_SESSION_MAX_AGE_S,
    });
    return res;
  }

  // Operator sign-in (unchanged).
  const expectedCookie = expectedOperatorCookieValue();
  if (!expectedCookie) {
    return NextResponse.json(
      { error: "operator sign-in unavailable: NIGHTSHIFT_API_TOKEN is not configured on this deployment" },
      { status: 401 },
    );
  }
  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }
  if (!presentedTokenMatches(body.token)) {
    return NextResponse.json({ error: "invalid operator token" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, mode: "operator" });
  res.cookies.set(OPERATOR_COOKIE, expectedCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: OPERATOR_SESSION_MAX_AGE_S,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true, mode: "anonymous" });
  res.cookies.set(OPERATOR_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  res.cookies.set(USER_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  return res;
}
