import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Operator-gate for watch-management APIs.
 *
 * NIGHTSHIFT has no user accounts: it is a single-operator deployment. When
 * NIGHTSHIFT_API_TOKEN is set, mutating watch-management requests
 * (create/delete a watch, trigger a check, including any paid investigation
 * mode) must present `Authorization: Bearer <token>`; every other request is
 * rejected with 401. When the token is NOT set the deployment runs in "open"
 * mode, which /api/status reports honestly as less hardened so an operator
 * cannot mistake the two.
 *
 * Reads (GETs of configs and history) stay public: configs are non-secret.
 */

export type ApiAuthMode = "open" | "token";

export function apiAuthMode(): ApiAuthMode {
  return process.env.NIGHTSHIFT_API_TOKEN ? "token" : "open";
}

export function requestAuthorized(req: Request): boolean {
  if (apiAuthMode() === "open") return true;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;
  const expected = process.env.NIGHTSHIFT_API_TOKEN ?? "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
