/**
 * One shared sentence for the failure every browser fetch can throw: the
 * connection to the server died before a response arrived. Safari names it
 * "Load failed", Chrome "Failed to fetch" — both are the network, not the
 * app, so the UI says so once, in plain language, instead of surfacing the
 * engine's raw TypeError text.
 */
export function friendlyNetworkError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/load failed|failed to fetch|networkerror|network error|aborted|connection (lost|refused|reset)|fetch failed/i.test(raw)) {
    return "The connection to the server dropped before an answer arrived — check your network, then retry.";
  }
  return raw;
}
