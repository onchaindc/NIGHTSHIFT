import { persistence } from "@/lib/storage";

/**
 * Telegram webhook deduplication facade — storage is provided by the swappable
 * backend.
 *
 * Telegram webhook delivery is at-least-once. For a bot that spends money,
 * reprocessing the same update must never create a second purchase, so we use
 * AT-MOST-ONCE processing: an update id is claimed BEFORE handling.
 * (Trade-off, chosen deliberately: if the process dies mid-handler the update
 * is dropped rather than re-spent; the user can resubmit a goal, but cannot
 * accidentally pay twice for one command.)
 *
 * Under Postgres the claim is a single atomic statement (INSERT ... ON
 * CONFLICT DO NOTHING), so concurrent webhook invocations can never both
 * process one update. Locally, claims serialize through a promise chain.
 */

export async function isUpdateProcessed(updateId: number | undefined): Promise<boolean> {
  return persistence().isUpdateClaimed(updateId);
}

export async function markUpdateProcessed(updateId: number | undefined): Promise<boolean> {
  return persistence().claimUpdate(updateId);
}

/**
 * Atomic claim: returns true if and only if this call is the one responsible
 * for processing the update.
 */
export async function claimUpdate(updateId: number | undefined): Promise<boolean> {
  return persistence().claimUpdate(updateId);
}

/** Test/dev helper: clears the persisted plus in-memory claim set entirely. */
export async function resetSeenUpdates(): Promise<void> {
  await persistence().clearSeenUpdates();
  await persistence().resetCaches();
}
