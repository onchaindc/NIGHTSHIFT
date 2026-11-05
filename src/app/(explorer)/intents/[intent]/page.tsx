import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { fetchIntents, fetchMiners } from "@/lib/explorer/network";
import { ParticipantCard } from "@/components/explorer/participant-card";

export const metadata = { title: "Intent" };
export const dynamic = "force-dynamic";

const MAX_MINERS = 24;

export default async function IntentDetailPage({ params }: { params: Promise<{ intent: string }> }) {
  const { intent } = await params;
  const wanted = decodeURIComponent(intent);
  const [fetchedIntents, fetchedMiners] = await Promise.all([fetchIntents(), fetchMiners()]);

  if (fetchedIntents.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · INTENT</p>
        <h1 className="x-display-1 mt-4 text-ink">Registry unavailable</h1>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
          The intent list could not be fetched: <span className="tabular text-[12px]">{fetchedIntents.detail}</span>
        </p>
      </div>
    );
  }

  const entry = fetchedIntents.payload.find(
    (i) => i.intent_id === wanted || i.intent_name === wanted || (i.intent_name ?? "").toUpperCase() === wanted.toUpperCase(),
  );
  if (!entry) notFound();
  const name = entry.intent_name ?? entry.intent_id;

  const miners =
    fetchedMiners.status === "ok" ? fetchedMiners.payload.filter((m) => (m.supported_intents ?? []).includes(name)) : [];
  const sorted = [...miners].sort((a, b) => (b.total_requests_served ?? 0) - (a.total_requests_served ?? 0));

  return (
    <article className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <Link href="/intents" className="inline-flex items-center gap-1.5 text-[12px] text-amber hover:text-amber-soft">
        <ArrowLeft size={12} aria-hidden /> All intents
      </Link>

      <header className="mt-6 border-b border-edge pb-8">
        <p className="x-tag">{entry.canonical ? "CANONICAL INTENT" : "INTENT"}</p>
        <h1 className="x-display-1 mt-3 text-ink">{name.toLowerCase().replaceAll("_", " ")}</h1>
        <p className="tabular mt-2 text-[12px] text-ink-faint">{name}</p>
        {entry.description && (
          <p className="mt-5 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-soft">{entry.description}</p>
        )}
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Miners serving now</p>
          <p className="tabular mt-1.5 text-[22px] font-semibold text-ink">{entry.miner_count}</p>
        </div>
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Tracked in catalog</p>
          <p className="mt-1.5 text-[13.5px] text-ink">{fetchedMiners.status === "ok" ? `${miners.length} records with this intent` : "Miner list unavailable"}</p>
        </div>
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Canonical registration</p>
          <p className="mt-1.5 text-[13.5px] text-ink">{entry.canonical ? "Registered on chain" : "Off-chain catalog entry"}</p>
        </div>
      </section>

      {/* Supporting miners */}
      <section className="mt-12">
        <p className="x-label">Supporting miners</p>
        {fetchedMiners.status === "ok" ? (
          sorted.length === 0 ? (
            <div className="mt-4 rounded-lg border border-edge bg-panel p-6 text-[13px] text-ink-soft">
              The catalog&apos;s miner records could not be cross-referenced with this intent right now.
            </div>
          ) : (
            <>
              <ul className="mt-4 grid gap-4 lg:grid-cols-2">
                {sorted.slice(0, MAX_MINERS).map((m) => (
                  <li key={m.slug ?? m.id}>
                    <ParticipantCard participant={m} />
                  </li>
                ))}
              </ul>
              {sorted.length > MAX_MINERS && (
                <p className="x-label mt-5">
                  SHOWING THE {MAX_MINERS} MOST-USED ·{" "}
                  <Link href={`/miners?intent=${encodeURIComponent(name)}`} className="underline decoration-dotted hover:text-amber">
                    see all {sorted.length}
                  </Link>
                </p>
              )}
            </>
          )
        ) : (
          <p className="mt-4 rounded-lg border border-edge bg-panel p-6 text-[13px] text-ink-soft">
            Miner catalog unavailable: <span className="tabular text-[11px]">{fetchedMiners.detail}</span>
          </p>
        )}
      </section>

      {/* Terminal hook */}
      <section className="mt-12 rounded-lg border border-amber/40 bg-amber-soft/40 p-6">
        <p className="x-tag">COMING IN THE INTERACTIVE TERMINAL</p>
        <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-soft">
          The terminal will accept a real question of this kind, classify it against the intent catalog, route it to the
          strongest supporting miner, and confirm the x402 price with you before anything is signed. Phase 2 ships that
          action layer.
        </p>
      </section>
    </article>
  );
}
