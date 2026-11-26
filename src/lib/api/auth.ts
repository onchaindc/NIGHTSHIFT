import { createHash, timingSafeEqual } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Operator gate for every API that can create, approve, execute or spend.
 *
 * NIGHTSHIFT has no user accounts: it is a single-operator deployment, so the
 * operator token is the only identity the server can check. The gate FAILS
 * CLOSED: when NIGHTSHIFT_API_TOKEN is not configured there is no way to tell
 * an operator from an anonymous caller, so sensitive routes authorize nobody.
 * /api/status reports that state honestly as "open" so it is never mistaken
 * for a hardened deployment.
 *
 * Writes and spends require the operator token. Reads return a PUBLIC
 * PROJECTION to anonymous callers (discovery-level fields only) and full
 * records to the operator: the bearer token, or the derived operator session
 * cookie established via /api/session.
 */

export type ApiAuthMode = "open" | "token";

export function apiAuthMode(): ApiAuthMode {
  return process.env.NIGHTSHIFT_API_TOKEN ? "token" : "open";
}

/** Constant-time comparison of a presented secret against a configured one. */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Constant-time check of a presented operator token against the configured
 * one. Both sides are trimmed: a token pasted into a dashboard or a phone
 * keyboard commonly carries a trailing space or newline, and that whitespace
 * must not be the difference between signing in and being refused.
 */
export function presentedTokenMatches(presented: string): boolean {
  const expected = (process.env.NIGHTSHIFT_API_TOKEN ?? "").trim();
  if (!expected) return false;
  return secretMatches(presented.trim(), expected);
}

/** The presented bearer token, or "" when the header is absent/malformed. */
export function bearerTokenOf(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Operator browser session. NIGHTSHIFT_API_TOKEN must never appear in browser
 * code or bundles, yet the console (Approvals, History, task detail) renders
 * full records that anonymous visitors must not see. The operator therefore
 * signs in once: the token is POSTed to /api/session over HTTPS, verified here
 * constant-time, and an HttpOnly cookie holding a DERIVED verifier (not the
 * token itself) is set. Read routes and console actions accept this cookie as
 * operator identity; the raw token still works everywhere via the bearer
 * header. Fails closed when the token (or the session) is not configured.
 */
export const OPERATOR_COOKIE = "ns_operator";
const OPERATOR_COOKIE_CONTEXT = "ns-operator-session-v1";

/** The cookie value a valid operator session presents, derived from the token. */
export function expectedOperatorCookieValue(): string {
  const token = (process.env.NIGHTSHIFT_API_TOKEN ?? "").trim();
  if (!token) return "";
  return createHash("sha256").update(`${token}|${OPERATOR_COOKIE_CONTEXT}`).digest("hex");
}

/** Authorization decision from already-parsed credentials. Always false when
 *  NIGHTSHIFT_API_TOKEN is unset — an unconfigured deployment authorizes nobody. */
export function requestAuthorizedFromParts(presentedBearer: string, operatorCookie: string | undefined): boolean {
  const expected = (process.env.NIGHTSHIFT_API_TOKEN ?? "").trim();
  if (!expected) return false;
  if (presentedBearer && secretMatches(presentedBearer.trim(), expected)) return true;
  const expectedCookie = expectedOperatorCookieValue();
  if (expectedCookie && operatorCookie && secretMatches(operatorCookie, expectedCookie)) return true;
  return false;
}

/** Cookie-header parse for the operator session (route handlers and RSC). */
export function operatorCookieFromHeader(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OPERATOR_COOKIE) return rest.join("=");
  }
  return undefined;
}

/**
 * `Authorization: Bearer <NIGHTSHIFT_API_TOKEN>`, or the operator session
 * cookie. Always false when the token is unset — an unconfigured deployment
 * never authorizes a privileged call.
 */
export function requestAuthorized(req: Request): boolean {
  return requestAuthorizedFromParts(bearerTokenOf(req), operatorCookieFromHeader(req.headers.get("cookie")));
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is
 * configured. Accepted only for the scheduler tick, and never when unset.
 */
export function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;
  const presented = bearerTokenOf(req);
  if (!presented) return false;
  return secretMatches(presented, expected);
}

// ---------------------------------------------------------------------------
// Wallet-signed USER sessions (multi-user production).
//
// The operator token above stays what it was: ONE identity for the deployment
// owner, and the signing secret for this cookie — but it is never again
// something a regular user types. Users sign in with their OWN in-app wallet:
// the browser asks the wallet to personal_sign a canonical, time-bound,
// explicitly-not-a-transaction message; the server verifies the signature
// recovers the claimed address (pure crypto, no secrets needed to verify) and
// issues an HttpOnly cookie carrying a HMAC-signed {address, exp} payload.
// The HMAC key derives from NIGHTSHIFT_API_TOKEN, which therefore remains an
// internal server secret while losing its role as a user-facing credential.
// Fails closed when the token is unset (no signing secret, no sessions).
// ---------------------------------------------------------------------------

import { createHmac, randomUUID } from "node:crypto";

import { buildUserSignInMessage } from "@/lib/api/signInMessage";

export { buildUserSignInMessage };

export const USER_COOKIE = "ns_user";
const USER_COOKIE_CONTEXT = "ns-user-session-v1";
export const USER_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

/** HMAC key for user session cookies; null when the deployment has no server secret. */
function userSessionKey(): Buffer | null {
  const token = (process.env.NIGHTSHIFT_API_TOKEN ?? "").trim();
  if (!token) return null;
  return createHmac("sha256", token).update(USER_COOKIE_CONTEXT).digest();
}

/** True when the deployment can issue user session cookies at all. */
export function userSessionsAvailable(): boolean {
  return userSessionKey() !== null;
}

/** Shape and freshness of a presented sign-in message (±10 minutes clock slack). */
export function userSignInMessageValid(
  message: string,
): { ok: true; address: string } | { ok: false; reason: string } {
  const m = /^NIGHTSHIFT sign-in\nAddress: (0x[0-9a-fA-F]{40})\nTime: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\nPurpose: prove wallet ownership/.exec(
    message,
  );
  if (!m) return { ok: false, reason: "the signed message is not the NIGHTSHIFT sign-in template" };
  const time = Date.parse(m[2]);
  if (!Number.isFinite(time)) return { ok: false, reason: "the signed message carries an unreadable time" };
  if (Math.abs(Date.now() - time) > 10 * 60 * 1000) {
    return { ok: false, reason: "the signed message has expired — sign a fresh one and retry" };
  }
  return { ok: true, address: m[1] };
}

/** Cookie value for a fresh user session: payload.signature (HMAC-signed, HttpOnly). */
export function userSessionCookieValue(address: string, nowMs: number = Date.now()): string {
  const key = userSessionKey();
  if (!key) return "";
  const payload = Buffer.from(
    JSON.stringify({ a: address.toLowerCase(), e: nowMs + USER_SESSION_MAX_AGE_S * 1000, n: randomUUID() }),
  ).toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify a presented user-session cookie; returns the lowercase address or null. */
export function userAddressFromSessionCookie(value: string | undefined): string | null {
  const key = userSessionKey();
  if (!key || !value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expectedSig = createHmac("sha256", key).update(payload).digest("base64url");
  if (!secretMatches(sig, expectedSig)) return null;
  let parsed: { a?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { a?: unknown; e?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.a !== "string" || typeof parsed.e !== "number") return null;
  if (parsed.e < Date.now()) return null;
  return parsed.a;
}

/** The wallet address of the caller's user session, or null. */
export function userAddressFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === USER_COOKIE) return userAddressFromSessionCookie(rest.join("="));
  }
  return null;
}

/**
 * Who is calling: the deployment operator (token or operator cookie), a
 * signed-in wallet user, or an anonymous visitor. Checked in that order.
 */
/**
 * The payer wallet IS the deployment operator: its key funds every paid run,
 * so a browser session verified to that address carries the same authority as
 * the operator token. This is what lets the deployment owner approve operator-
 * or agent-created runs (ownerless handoff tasks) from any browser signed in
 * with the funding wallet — no token paste required.
 */
export function isPayerAddress(address: string | null | undefined): boolean {
  const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
  if (!key || !address) return false;
  try {
    return privateKeyToAccount(key as `0x${string}`).address.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

export type CallerIdentity =
  | { kind: "operator" }
  | { kind: "user"; address: string }
  | { kind: "anonymous" };

export function callerIdentity(req: Request): CallerIdentity {
  if (requestAuthorized(req)) return { kind: "operator" };
  const address = userAddressFromRequest(req);
  if (address && isPayerAddress(address)) return { kind: "operator" };
  return address ? { kind: "user", address } : { kind: "anonymous" };
}

/** Write/spend authorization for multi-user routes: operator OR wallet session. */
export function requestAuthorizedOrUser(req: Request): { authorized: boolean; userAddress: string | null } {
  if (requestAuthorized(req)) return { authorized: true, userAddress: null };
  const address = userAddressFromRequest(req);
  return { authorized: !!address, userAddress: address };
}
