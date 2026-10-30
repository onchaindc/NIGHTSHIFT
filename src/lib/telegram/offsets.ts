import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/engine/store";

/**
 * Telegram webhook delivery is at-least-once. For a bot that spends money,
 * reprocessing the same update must never create a second purchase, so we use
 * AT-MOST-ONCE processing: an update id is marked as seen BEFORE handling.
 * (Trade-off, chosen deliberately: if the process dies mid-handler the update
 * is dropped rather than re-spent; the user can resubmit a goal, but cannot
 * accidentally pay twice for one command.)
 *
 * The seen-set is persisted next to the task store so a restart does not
 * forget which updates were already handled.
 */

function file(): string {
  return path.join(dataDir(), "telegram-seen-updates.json");
}

const seen = new Set<number>();
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(file(), "utf8");
    for (const id of JSON.parse(raw) as number[]) seen.add(id);
  } catch {
    // first run
  }
}

async function persist(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = file() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify([...seen]));
  await fs.rename(tmp, file());
}

export async function isUpdateProcessed(updateId: number | undefined): Promise<boolean> {
  if (updateId === undefined) return false; // no id → nothing to dedupe on
  await ensureLoaded();
  return seen.has(updateId);
}

export async function markUpdateProcessed(updateId: number | undefined): Promise<void> {
  if (updateId === undefined) return;
  await ensureLoaded();
  seen.add(updateId);
  if (seen.size > 5000) {
    // Bound the file: drop the oldest half once it grows large.
    const ids = [...seen].sort((a, b) => a - b);
    seen.clear();
    for (const id of ids.slice(ids.length / 2)) seen.add(id);
  }
  await persist();
}

/**
 * Test/dev helper: forgets in-memory state AND the persisted seen-set file, so
 * the next claim starts clean. Resetting only memory is insufficient: without
 * the fresh reload the next claim re-reads the stale file and would silently
 * treat every previously used update id as already processed.
 */
export async function resetSeenUpdates(): Promise<void> {
  seen.clear();
  loaded = false;
  try {
    await fs.rm(file(), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Atomic claim: returns true if and only if this call is the one responsible
 * for processing the update. Serializes claims through a promise chain so two
 * concurrent webhook deliveries of the same update cannot both claim it.
 */
let claimChain: Promise<unknown> = Promise.resolve();

export function claimUpdate(updateId: number | undefined): Promise<boolean> {
  const next = claimChain.then(async () => {
    if (updateId === undefined) return true; // no id → nothing to dedupe on
    await ensureLoaded();
    if (seen.has(updateId)) return false;
    seen.add(updateId);
    await persist();
    return true;
  }) as Promise<boolean>;
  claimChain = next.catch(() => undefined);
  return next;
}
