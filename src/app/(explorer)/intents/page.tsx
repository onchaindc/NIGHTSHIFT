import Link from "next/link";
import { Search } from "lucide-react";

import { fetchIntents } from "@/lib/explorer/network";

export const metadata = { title: "Intents" };
export const dynamic = "force-dynamic";

export default async function IntentsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const fetched = await fetchIntents();

  if (fetched.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-eyebrow">Intents</p>
        <h1 className="x-display-1 mt-4 text-ink">Intent registry unavailable</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The canonical intent list could not be fetched: <span className="tabular text-[12px]">{fetched.detail}</span>{" "}
          Nothing is shown rather than a cached or invented list.
        </p>
        <Link href="/" className="btn-quiet mt-6 !min-h-9">Back to overview</Link>
      </div>
    );
  }

  const qTrim = q.trim().toLowerCase();
  const pool = qTrim
    ? fetched.payload.filter(
        (i) =>
          i.intent_name?.toLowerCase().includes(qTrim) ||
          i.intent_id?.toLowerCase().includes(qTrim) ||
          i.description?.toLowerCase().includes(qTrim),
      )
    : fetched.payload;

  const canonicalCount = fetched.payload.filter((i) => i.canonical).length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-eyebrow">{canonicalCount} canonical intents</p>
          <h1 className="x-display-1 mt-3 text-ink">{pool.length.toLocaleString()} named kinds of question</h1>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-ink-soft">
            Intents are the network&apos;s shared vocabulary. Miners declare the intents they serve, and evaluation
            scores them per intent each epoch, so the catalog is the right lens for browsing capability.
          </p>
        </div>
        <form action="/intents" method="GET" className="flex items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q.trim()}
            placeholder="Search intents…"
            aria-label="Search intents"
            className="min-h-10 w-full max-w-xs rounded-lg border border-edge bg-panel px-3.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal sm:w-64"
          />
          <button type="submit" aria-label="Search" className="btn-primary !min-h-10 !px-3">
            <Search size={14} aria-hidden />
          </button>
        </form>
      </div>

      {pool.length === 0 ? (
        <div className="mt-12 rounded-lg border border-edge bg-panel p-8">
          <p className="text-[13px] font-semibold text-ink">No matches</p>
          <p className="mt-3 text-[14px] text-ink-soft">No intent in the registry matches this search. Clear the filters and try again.</p>
        </div>
      ) : (
        <ul className="mt-10 divide-y divide-edge border-y border-edge">
          {pool.map((i) => (
            <li key={i.intent_name ?? i.intent_id}>
              <Link
                href={`/intents/${encodeURIComponent(i.intent_name ?? i.intent_id)}`}
                className="group flex flex-wrap items-baseline gap-x-4 gap-y-1 px-2 py-4 transition-colors hover:bg-panel"
              >
                <span className="tabular w-full shrink-0 text-[12px] font-medium text-ink group-hover:text-teal sm:w-44">
                  {(i.intent_name ?? i.intent_id).toLowerCase().replaceAll("_", " ")}
                </span>
                <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-soft line-clamp-2">{i.description ?? "No description published."}</span>
                <span className="tabular shrink-0 text-[11.5px] text-ink-faint">{i.miner_count} miners →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
