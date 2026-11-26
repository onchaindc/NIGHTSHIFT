"use client";

import { useEffect, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";

/**
 * Client-side mirror of the server's stall reaper.
 *
 * The server guarantees every run reaches a terminal state (bounded calls,
 * 240s run budget, 90s stall reaper on every read) — but the CONSOLE shows its
 * own spinner while it polls, and a wedged serverless invocation can leave
 * those polls unanswered long enough for a user to conclude the run hung. This
 * hook makes the wait honest: it surfaces how long since the server last
 * updated the record, and flags an unusually long run so the UI can say "the
 * server may have been interrupted; the next check will fail it cleanly"
 * instead of an eternal spinner.
 *
 * awaiting_approval deliberately does NOT age: waiting for a human is
 * legitimate and unbounded (same rule as the server reaper).
 */

/** Server run budget is 240s; warn at 2x margin with poll latency. */
export const RUN_WATCHDOG_MS = 8 * 60_000;
/** A healthy run saves after every step event (bounded calls <= 30s each); the
 *  server reaper fails any run silent for 90s. If the client sees > 150s of
 *  silence, the server is wedged or gone — say so instead of spinning. */
export const SILENCE_WARN_MS = 150_000;

const RUNNING_STATES = new Set(["created", "planning", "executing", "verifying"]);

export function isRunningState(state: TaskRecord["state"] | string | null): boolean {
  return !!state && RUNNING_STATES.has(state);
}

/** Minimal shape the watchdog needs — accepts TaskRecord and the desk's narrower snapshot. */
export interface WatchedTask {
  state: string | null;
  createdAt: number;
  updatedAt: number;
}

export function useRunWatchdog(task: WatchedTask | null | undefined): { secondsSinceUpdate: number; longRun: boolean; silent: boolean } {
  const [, setTick] = useState(0);
  const active = !!task && isRunningState(task.state);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active, task?.updatedAt]);

  if (!task) return { secondsSinceUpdate: 0, longRun: false, silent: false };
  const reference = Math.max(task.updatedAt || 0, task.createdAt || 0);
  const secondsSinceUpdate = active ? Math.max(0, Math.round((Date.now() - reference) / 1000)) : 0;
  return {
    secondsSinceUpdate,
    longRun: active && Date.now() - (task.createdAt || 0) > RUN_WATCHDOG_MS,
    silent: active && Date.now() - reference > SILENCE_WARN_MS,
  };
}
