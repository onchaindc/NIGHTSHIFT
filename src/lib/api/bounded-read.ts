/**
 * Deadline for one server-side read: resolves with the value, or null when
 * the read rejects or does not settle within `ms`. The caller decides what
 * null means — the Overview page renders an honest partial view with a
 * failure banner instead of ever hanging its RSC stream (a page that waits
 * forever is indistinguishable from a broken one to the person waiting, and
 * is exactly what showed as an endless loading state before the platform
 * killed it into the error boundary).
 */
export function readBounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Outcome-valued read for pages that must DISTINGUISH a failed read from a
 * verified-empty store. `readBounded`'s null is ambiguous: a detail page that
 * renders "not found" for a timed-out read lies to the user about a record
 * that exists, and a dashboard that renders 0 for a failed read manufactures
 * data. `ok` means the read SETTLED with a value (null value allowed — the
 * store genuinely has no such record); `failed` means the deadline passed or
 * the read rejected, and the page renders a retry action instead of a fact.
 */
export type ReadOutcome<T> = { state: "ok"; value: T } | { state: "failed"; reason: string };

export function readOutcome<T>(work: Promise<T>, ms: number): Promise<ReadOutcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: "failed", reason: "read deadline exceeded" }), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ state: "ok", value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        resolve({ state: "failed", reason: err instanceof Error ? err.message : "read failed" });
      },
    );
  });
}
