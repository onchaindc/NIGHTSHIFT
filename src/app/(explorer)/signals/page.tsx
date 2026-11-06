import Link from "next/link";

import { daemonWsUrl, fetchSignalCategories, fetchSignals, toRows } from "@/lib/daemon/client";
import { SignalsFeed } from "@/components/signals/signals-feed";

export const metadata = { title: "Signals" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; category?: string; hours?: string }>;
}) {
  const { type = "", category = "", hours = "" } = await searchParams;

  const [fetched, cats] = await Promise.all([
    fetchSignals({ type, category, sinceHours: Number(hours) || undefined, limit: PAGE_SIZE, offset: 0 }),
    fetchSignalCategories(),
  ]);

  if (fetched.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · SIGNALS</p>
        <h1 className="x-display-1 mt-4 text-ink">Daemon feed unavailable</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The Daemon&apos;s public feed could not be read, so no signals are listed rather than a cached or invented
          list. Detail: <span className="tabular text-[12px]">{fetched.detail}</span>
        </p>
        <Link href="/" className="btn-quiet mt-6 !min-h-9">
          Back to overview
        </Link>
      </div>
    );
  }

  const payload = fetched.payload;
  const categories = (cats.status === "ok" ? cats.payload.stats : [])
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ category: s.category, count: s.count }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-tag">EXPLORER · SIGNALS · {payload.total.toLocaleString()} ON RECORD</p>
          <h1 className="x-display-1 mt-3 text-ink">Daemon signals</h1>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-ink-soft">
            Signals the Daemon produced on its own schedule: collectors gather data, the Daemon formulates questions,
            and routed miners answer. Newest first. Signal pushes over the WebSocket require an escrowed wallet
            subscription, so this view refreshes the free feed instead and stays connected to the official
            interface for liveness.
          </p>
        </div>
      </div>

      <SignalsFeed
        initialRows={toRows(payload)}
        initialTotal={payload.total}
        wsUrl={daemonWsUrl()}
        categories={categories}
        filters={{ type, category: category.toUpperCase(), hours }}
      />
    </div>
  );
}
