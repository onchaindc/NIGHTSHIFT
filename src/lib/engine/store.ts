import type { TaskRecord } from "./types";
import { persistence } from "@/lib/storage";

/**
 * Task persistence facade. Storage is provided by the swappable backend in
 * src/lib/storage (JSON files locally, durable Postgres in production); this
 * module keeps only task-specific concerns: display normalization and the
 * public API the engine and routes depend on. Application code is unchanged.
 *
 * Postgres row: ns_tasks(id, created_at, state, data jsonb) — one row per
 * task, whole-record atomic upsert, sorted reads by creation time.
 */

export { dataDir, isVercelRuntime, persistenceMode } from "@/lib/storage";

/** Old records may still carry an em dash in user-facing text. Normalize
 * them on read so nothing the user sees reintroduces the character. New
 * events are written em-dash-free by construction. */
function normalizeTaskForDisplay(task: TaskRecord): TaskRecord {
  return {
    ...task,
    goal: cleanText(task.goal),
    error: task.error === null ? null : cleanText(task.error),
    events: task.events.map((e) => ({ ...e, message: cleanText(e.message) })),
    spend: {
      ...task.spend,
      entries: task.spend.entries.map((e) => ({ ...e, description: cleanText(e.description) })),
    },
    result: task.result ? { ...task.result, summary: cleanText(task.result.summary) } : task.result,
  };
}

function cleanText(s: string): string {
  return s.replace(/—/g, ",");
}

const store = () => persistence();

export async function listTasks(): Promise<TaskRecord[]> {
  const tasksList = [...(await store().listTasks())].sort((a, b) => b.createdAt - a.createdAt);
  return tasksList.map((row) => normalizeTaskForDisplay(row.data));
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  const task = await store().getTask(id);
  return task ? normalizeTaskForDisplay(task) : null;
}

export async function saveTask(record: TaskRecord): Promise<void> {
  await store().saveTask(record);
}

/** Test/dev helper: drops in-memory caches so reads reload from the store
 * (exactly like a process restart). Deletes nothing that is persisted. */
export function resetStore(): void {
  void store().resetCaches();
}
