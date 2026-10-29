import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "@/lib/engine/store";
import { assertHttpUrl, rejectPrivateTarget, SsrfBlockedError } from "./ssrf";
import type { WatchConfig, WatchSource } from "./types";
import { isSupportedType } from "./sources";

/**
 * JSON-file persistence for watch configurations, next to the task store.
 * Fingerprints (per-source last-seen signatures) live inside each config, so
 * a process restart never forgets what was already observed and never
 * re-reports old changes. Same durability model as the task store: one file,
 * atomic rename, single process.
 */

function file(): string {
  return path.join(dataDir(), "watches.json");
}

let cache: WatchConfig[] | null = null;

async function ensureLoaded(): Promise<WatchConfig[]> {
  if (cache) return cache;
  try {
    cache = (JSON.parse(await fs.readFile(file(), "utf8")) as WatchConfig[]) ?? [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(watches: WatchConfig[]): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = file() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(watches, null, 2));
  await fs.rename(tmp, file());
}

export async function listWatches(): Promise<WatchConfig[]> {
  return [...(await ensureLoaded())].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getWatch(id: string): Promise<WatchConfig | null> {
  const all = await ensureLoaded();
  return all.find((w) => w.id === id) ?? null;
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

  const all = await ensureLoaded();
  all.push(watch);
  await persist(all);
  return watch;
}

export async function deleteWatch(id: string): Promise<boolean> {
  const all = await ensureLoaded();
  const next = all.filter((w) => w.id !== id);
  if (next.length === all.length) return false;
  await persist(next);
  cache = next;
  return true;
}

/**
 * Mutates the persisted config (fingerprints, lastCheckedAt) after a check
 * run. Takes a mutator so future fields stay in one place.
 */
export async function mutateWatch(
  id: string,
  mutate: (w: WatchConfig) => void,
): Promise<WatchConfig | null> {
  const all = await ensureLoaded();
  const watch = all.find((w) => w.id === id);
  if (!watch) return null;
  const idx = all.indexOf(watch);
  const nextWatch: WatchConfig = JSON.parse(JSON.stringify(watch)) as WatchConfig;
  mutate(nextWatch);
  nextWatch.updatedAt = Date.now();
  all[idx] = nextWatch;
  await persist(all);
  cache = all;
  return nextWatch;
}

/** Test helper: clears the in-memory cache so the file is re-read. */
export function resetWatchStore(): void {
  cache = null;
}
