import { persistenceMode } from "@/lib/engine/store";
import ActivityView from "@/components/activity/activity-view";

export const metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

/**
 * The Activity Centre reads ONLY recorded persistence — the same task store
 * the engine writes through (crate: src/lib/storage). Nothing here synthesizes
 * history: if a record was never saved, it cannot appear, and if the store is
 * ephemeral on this deployment the view says so instead of implying durability.
 */
export default async function ActivityPage() {
  let mode = "local";
  try {
    mode = persistenceMode();
  } catch {
    /* default to the least-durable honest label if the store cannot even agree on its mode */
    mode = "ephemeral";
  }
  return <ActivityView persistenceMode={mode} />;
}
