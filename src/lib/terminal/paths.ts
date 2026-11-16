const ASK_ROOT = "/engine/v1/ask";

/**
 * The Terminal only proxies the node's ask endpoint, optionally for one
 * pinned miner. Checking `startsWith` alone is not enough: a value like
 * `/engine/v1/ask/../../admin` also starts with the allowed prefix and can be
 * normalized by the upstream server into a different endpoint.
 *
 * Accept exactly `/engine/v1/ask` or one non-empty path segment. Reject
 * separators (including encoded ones), query/fragment markers and whitespace.
 */
export function normalizeAskPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === ASK_ROOT) return ASK_ROOT;
  if (!value.startsWith(`${ASK_ROOT}/`)) return null;

  const raw = value.slice(ASK_ROOT.length + 1);
  if (!raw) return null;

  let segment: string;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (!segment || segment === "." || segment === "..") return null;
  if (/[\/\\?#\s\u0000-\u001f\u007f]/.test(segment)) return null;

  return value;
}
