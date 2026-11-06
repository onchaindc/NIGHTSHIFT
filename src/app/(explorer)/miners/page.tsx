import Link from "next/link";
import { Search } from "lucide-react";

import { fetchIntents, fetchMiners, type NetworkMiner } from "@/lib/explorer/network";
import { ParticipantCard } from "@/components/explorer/participant-card";

export const metadata = { title: "Miners" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 60;

function match(miner: NetworkMiner, q: string): boolean {
  const needle = q.toLowerCase();
  if (!needle) return true;
  if (miner.name?.toLowerCase().includes(needle)) return true;
  if (miner.slug?.toLowerCase().includes(needle)) return true;
  if (miner.protocol?.toLowerCase().includes(needle)) return true;
  if (miner.description?.toLowerCase().includes(needle)) return true;
  return (miner.supported_intents ?? []).some((i) => i.toLowerCase().includes(needle));
}

export default async function MinersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; intent?: string; page?: string }>;
}) {
  const { q = "", intent = "", page = "1" } = await searchParams;
  const [fetched, intents] = await Promise.all([fetchMiners(), fetchIntents()]);

  if (fetched.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · MINERS</p>
        <h1 className="x-display-1 mt-4 text-ink">Miner catalog unavailable</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The public node at devnode.telegraphprotocol.com could not be reached, so no miners are listed rather than a
          cached or invented list. Detail: <span className="tabular text-[12px]">{fetched.detail}</span>
        </p>
        <Link href="/" className="btn-quiet mt-6 !min-h-9">
          Back to overview
        </Link>
      </div>
    );
  }

  if (intents.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · MINERS</p>
        <h1 className="x-display-1 mt-4 text-ink">Intents registry unavailable</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The intent list could not be fetched, so miners cannot be grouped by intent right now. Retry shortly.
        </p>
        <Link href="/" className="btn-quiet mt-6 !min-h-9">
          Back to overview
        </Link>
      </div>
    );
  }

  const qTrim = q.trim();
  const intentSlug = intent.trim();

  let pool: NetworkMiner[] = fetched.payload;
  if (intentSlug) {
    const named = intents.payload.find((i) => i.intent_name === intentSlug);
    const needles = [intentSlug, named?.intent_id ?? ""].filter(Boolean).map((s) => s.toUpperCase());
    pool = pool.filter((m) => (m.supported_intents ?? []).some((si) => needles.includes(si.toUpperCase())));
  }
  if (qTrim) {
    pool = pool.filter((m) => match(m, qTrim));
  }
  pool = [...pool].sort((a, b) => (b.total_requests_served ?? 0) - (a.total_requests_served ?? 0));

  const total = pool.length;
  const pageN = Math.max(1, parseInt(page, 10) || 1);
  const startIdx = (pageN - 1) * PAGE_SIZE;
  const slice = pool.slice(startIdx, startIdx + PAGE_SIZE);

  const topIntents = [...intents.payload].sort((a, b) => b.miner_count - a.miner_count).slice(0, 12);
  const friendly = (s: string) => s.toLowerCase().replaceAll("_general", "").replaceAll(/_/g, " ");

  const pageHref = (n: number) => ({
    pathname: "/miners",
    query: Object.fromEntries(
      Object.entries({ q: qTrim, intent: intentSlug, page: n > 1 ? String(n) : undefined }).filter(
        ([, v]) => v !== undefined,
      ),
    ) as Record<string, string>,
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="x-tag">EXPLORER · MINERS · {fetched.payload.length.toLocaleString()} REGISTERED</p>
          <h1 className="x-display-1 mt-3 text-ink">{total.toLocaleString()} miners on the network</h1>
          <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-ink-soft">
            Every entry is a registry record: an independent service with declared endpoints, schemas, supported
            intents and price. Ordered by reported requests served, where a miner reports it.
          </p>
        </div>
        <form action="/miners" method="GET" className="flex items-center gap-2">
          {intentSlug && <input type="hidden" name="intent" value={intentSlug} />}
          <input
            type="search"
            name="q"
            defaultValue={qTrim}
            placeholder="Search the miner catalog…"
            aria-label="Search miners"
            className="min-h-10 w-full max-w-xs rounded-lg border border-edge bg-panel px-3.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal sm:w-64"
          />
          <button type="submit" aria-label="Search" className="btn-primary !min-h-10 !px-3">
            <Search size={14} aria-hidden />
          </button>
        </form>
      </div>

      {/* Quick intent filters when no explicit filter is chosen */}
      {!intentSlug && (
        <div className="mt-7">
          <span className="x-label block sm:hidden">Filter by intent</span>
          {/* Phone: one swipeable row keeps the twelve filters from eating the
              screen. From sm up they wrap as before. */}
          <div className="-mx-4 mt-2 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:mt-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
            <span className="x-label hidden self-center sm:block">Filter by intent</span>
            {topIntents.map((i) => (
              <Link
                key={i.intent_name ?? i.intent_id}
                href={{ pathname: "/miners", query: { intent: i.intent_name ?? i.intent_id } }}
                className="shrink-0 snap-start rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-teal"
              >
                {friendly(i.intent_name ?? i.intent_id)}
                <span className="tabular ml-1.5 text-ink-faint">{i.miner_count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {intentSlug && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-teal bg-teal/5 px-3 py-1.5 text-[12px] font-medium text-teal">
            Intent: {intentSlug}
          </span>
          <Link href="/miners" className="text-[12px] text-amber underline decoration-amber/40 underline-offset-4 hover:text-amber-soft">
            Clear intent filter
          </Link>
        </div>
      )}
      {qTrim && (
        <p className="x-label mt-3">
          SEARCH: “{qTrim}” · {total.toLocaleString()} MATCH{total === 1 ? "" : "ES"}
          <Link href={pageHref(1)} className="ml-3 underline decoration-dotted hover:text-amber">
            clear search
          </Link>
        </p>
      )}

      {/* Results */}
      {slice.length === 0 ? (
        <div className="mt-12 rounded-lg border border-edge bg-panel p-8">
          <p className="x-tag">NO MATCHES</p>
          <p className="mt-3 text-[14px] text-ink-soft">
            No miner in the registry matches this search. Try a broader query or clear the filters.
          </p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 lg:grid-cols-2">
          {slice.map((m) => (
            <li key={m.slug ?? m.id} className="rise-in-item">
              <ParticipantCard participant={m} />
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <nav aria-label="Pagination" className="mt-10 flex items-center justify-between border-t border-edge pt-6">
          {startIdx > 0 ? (
            <Link href={pageHref(pageN - 1)} className="btn-quiet !min-h-9">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <p className="x-label">
            PAGE {pageN} · SHOWING {startIdx + 1}–{Math.min(startIdx + PAGE_SIZE, total)} OF {total.toLocaleString()}
          </p>
          {startIdx + PAGE_SIZE < total ? (
            <Link href={pageHref(pageN + 1)} className="btn-quiet !min-h-9">
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
