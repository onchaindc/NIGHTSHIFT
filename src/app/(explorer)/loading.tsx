/**
 * Route-level loading shell for the Explorer.
 *
 * Every Explorer page is `force-dynamic` and waits on live public-registry
 * reads (miner catalog, intent registry, Daemon feed, live challenge).
 * Curl-timed, the server work costs 1.1-2.7s even warm, which reads as slow
 * navigation. This shell paints the app's chrome instantly while the real
 * page streams in — the displayed data is unchanged and never cached away;
 * nothing happens faster, it simply stops LOOKING blocked.
 */
export default function ExplorerLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6" role="status" aria-live="polite">
      <div aria-hidden className="h-2.5 w-36 rounded bg-panel-2 motion-safe:animate-pulse" />
      <div aria-hidden className="mt-4 h-10 w-64 max-w-[70vw] rounded bg-panel-2 motion-safe:animate-pulse" />
      <div aria-hidden className="mt-4 h-4 w-full max-w-[58ch] rounded bg-panel-2/70 motion-safe:animate-pulse" />
      <div aria-hidden className="mt-8 grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-edge bg-panel p-5">
            <div className="h-3 w-24 rounded bg-panel-2 motion-safe:animate-pulse" />
            <div className="mt-3 h-3 w-full rounded bg-panel-3 motion-safe:animate-pulse" />
            <div className="mt-2 h-3 w-2/3 rounded bg-panel-3 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
      <p className="x-label mt-6">Reading the public registries…</p>
    </div>
  );
}
