import { createHash, timingSafeEqual } from "node:crypto";

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
