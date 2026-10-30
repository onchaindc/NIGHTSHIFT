import { randomUUID } from "node:crypto";
import { assertHttpUrl, rejectPrivateTarget, SsrfBlockedError } from "./ssrf";
import { persistence } from "@/lib/storage";
import type { WatchConfig, WatchSource } from "./types";
import { isSupportedType } from "./sources";

/**
 * Watch persistence facade. Validation, SSRF checks and config semantics live
 * HERE; storage is provided by the swappable backend (JSON files locally,
 * durable Postgres rows in production). Fingerprints (per-source last-seen
 * signatures) live inside each config, so a process restart never forgets
 * what was already observed and never re-reports old changes.
 */

export async function listWatches(): Promise<WatchConfig[]> {
  return (await persistence().listWatches()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getWatch(id: string): Promise<WatchConfig | null> {
  return persistence().getWatch(id);
}

export interface CreateWatchInput {
  name: string;
  protocol: string;
  sources: Array<{ type: string; label?: string; target: string }>;
  spendLimitUsdCents?: number;
  requiresApprovalForPaid?: boolean;
  telegramChatId?: string | number | null;
}

export class WatchValidationError extends Error {}

const SOURCE_TYPE_ACTIVITY: Record<string, string> = {
  github_releases: "publishes releases on GitHub",
  github_commits: "pushes commits to GitHub",
  docs_url: "documents behavior on a public docs page",
  discourse_forum: "discusses governance on a Discourse forum",
  rss_feed: "announcements via an RSS/Atom feed",
};

export async function createWatch(input: CreateWatchInput, now = Date.now()): Promise<WatchConfig> {
  const name = (input.name || "").trim();
  const protocol = (input.protocol || "").trim();
  if (!name) throw new WatchValidationError("a watch name is required");
  if (!protocol) throw new WatchValidationError("the protocol being watched is required");
  if (!input.sources || input.sources.length === 0) throw new WatchValidationError("add at least one source to watch");
  if (input.sources.length > 5) throw new WatchValidationError("a watch supports at most 5 sources");

  const sources: WatchSource[] = [];
  for (const [i, s] of input.sources.entries()) {
    const type = (s.type || "").trim();
    const target = (s.target || "").trim();
    if (!isSupportedType(type)) throw new WatchValidationError(`source ${i + 1}: unsupported type "${s.type}"`);
    if (!target) throw new WatchValidationError(`source ${i + 1}: a target (repository, URL, or feed) is required`);
    if (!SOURCE_TYPE_ACTIVITY[type]) throw new WatchValidationError(`source ${i + 1}: unsupported type`);
    if (type.startsWith("github")) {
      // GitHub sources are host-less: normalize and enforce an owner/repo pair
      // so no clever path can turn "owner/repo" into another API endpoint.
      const repo = target.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new WatchValidationError(`source ${i + 1}: GitHub sources must be an owner/repo pair, for example "Uniswap/sdks"`);
      }
    } else {
      // URL-based sources are user-supplied and are resolved on every check:
      // reject unsafe targets at creation instead of failing every run later.
      try {
        assertHttpUrl(target);
        // Fail-fast on targets that resolve into private, loopback, link-local
        // or cloud-metadata space. A DNS-unavailable environment still passes
        // here; every runtime fetch re-validates, so this is belt-and-braces.
        await rejectPrivateTarget(target);
      } catch (err) {
        const reason = err instanceof SsrfBlockedError || err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err);
        throw new WatchValidationError(`source ${i + 1}: ${reason}`);
      }
    }
    const label =
      (s.label || "").trim() ||
      (type.startsWith("github") ? target.replace(/^https?:\/\/github\.com\//, "") : target.replace(/^https?:\/\//, "").slice(0, 60));
    sources.push({ id: randomUUID(), type: type as WatchSource["type"], label, target: type.startsWith("github") ? target.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "") : target });
  }

  const limit = Math.round(input.spendLimitUsdCents ?? 100);
  if (!Number.isFinite(limit) || limit <= 0) throw new WatchValidationError("the per-run spend ceiling must be greater than zero");

  const watch: WatchConfig = {
    id: randomUUID(),
    name,
    protocol,
    sources,
    spendLimitUsdCents: limit,
    requiresApprovalForPaid: input.requiresApprovalForPaid === true,
    telegramChatId: input.telegramChatId || null,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: null,
    fingerprints: {},
  };
  await persistence().insertWatch(watch);
  return watch;
}

export async function deleteWatch(id: string): Promise<boolean> {
  return persistence().removeWatch(id);
}

/**
 * Mutates the persisted config (fingerprints, lastCheckedAt) after a check
 * run. Takes a mutator so future fields stay in one place.
 */
/**
 * Mutates the persisted config (fingerprints, lastCheckedAt) after a check
 * run. The storage backend serializes concurrent mutations: under Postgres,
 * the row is locked and updated inside a transaction, so two overlapping
 * workers can never interleave their mutations.
 */
export async function mutateWatch(
  id: string,
  mutate: (w: WatchConfig) => void,
): Promise<WatchConfig | null> {
  return persistence().updateWatch(id, mutate);
}

/** Test helper: drops in-memory caches so reads reload from storage (like a restart). */
export function resetWatchStore(): void {
  void persistence().resetCaches();
}
