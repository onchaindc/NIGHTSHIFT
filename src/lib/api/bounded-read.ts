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
