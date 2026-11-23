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
 * Reads (GETs of history, status, catalogues) stay public: they are
 * non-secret and spend nothing.
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

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * `Authorization: Bearer <NIGHTSHIFT_API_TOKEN>`. Always false when the token
 * is unset — an unconfigured deployment never authorizes a privileged call.
 */
export function requestAuthorized(req: Request): boolean {
  const expected = process.env.NIGHTSHIFT_API_TOKEN ?? "";
  if (!expected) return false;
  const presented = bearer(req);
  if (!presented) return false;
  return secretMatches(presented, expected);
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is
 * configured. Accepted only for the scheduler tick, and never when unset.
 */
export function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;
  const presented = bearer(req);
  if (!presented) return false;
  return secretMatches(presented, expected);
}
