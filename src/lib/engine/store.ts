import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskRecord } from "./types";

/**
 * JSON-file persistence for tasks. One file, one in-memory map, written on
 * every mutation. Single-process by design; swap this module for a database
 * later without touching the engine.
 */

export function dataDir(): string {
  return process.env.NIGHTSHIFT_DATA_DIR || path.join(process.cwd(), ".data");
}

function dataFile(): string {
  return path.join(dataDir(), "tasks.json");
}

const tasks = new Map<string, TaskRecord>();
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(dataFile(), "utf8");
    const parsed = JSON.parse(raw) as TaskRecord[];
    for (const t of parsed) tasks.set(t.id, t);
  } catch {
    // No file yet (first run) — fine.
  }
}

async function persist(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = dataFile() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify([...tasks.values()], null, 2));
  await fs.rename(tmp, dataFile());
}

export async function listTasks(): Promise<TaskRecord[]> {
  await ensureLoaded();
  const tasksList = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  return tasksList.map(normalizeTaskForDisplay);
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  await ensureLoaded();
  const task = tasks.get(id);
  return task ? normalizeTaskForDisplay(task) : null;
}

export async function saveTask(record: TaskRecord): Promise<void> {
  await ensureLoaded();
  tasks.set(record.id, record);
  await persist();
}

/**
 * Old records may still carry an em dash in user-facing event text. Normalize
 * them on read so nothing the user sees reintroduces the character. New events
 * are written em-dash-free by construction.
 */
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

export function resetStore(): void {
  tasks.clear();
  loaded = false;
}
