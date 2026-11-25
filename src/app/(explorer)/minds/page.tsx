import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { MINDS, mindIndex, mindsByStatus } from "@/lib/minds/registry";
import { CAPABILITIES } from "@/lib/minds/capabilities";
import { MIND_FOUNDATION } from "@/lib/minds/foundation";
import { MindStatusChip } from "@/components/minds/status-chip";

export const metadata = {
  title: "Minds",
  description:
    "NIGHTSHIFT Minds: specialist intelligence capabilities for counterparties, indices, mining, trade, ownership, sanctions and more — on one evidence and payment foundation.",
};

/**
 * The Minds catalogue. Registry-driven, grouped by real status. The live cards
 * stay deliberately small: the hub is for choosing a Mind, while verified
 * intents, miners and per-asset evidence belong on the profile and the
 * investigation itself.
 */
export default function MindsPage() {
  const available = mindsByStatus("available");
  const inDevelopment = mindsByStatus("in_development");
  const planned = mindsByStatus("planned");

  return (
    <div className="mx-auto max-w-6xl px-4 py-9 sm:px-6">
      <header className="max-w-[64ch]">
        <p className="x-eyebrow">NIGHTSHIFT MINDS</p>
        <h1 className="x-display-1 mt-3 text-ink">Specialists for decisions that carry consequence.</h1>
        <p className="mt-4 text-[13.5px] leading-relaxed text-ink-soft">
          Each Mind investigates one business domain with a pinned provider, a published price and an evidence
          trail. They share the same engine — planning, approval, controlled spending, verification and history.
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-teal" />
          {available.length} available
        </span>
        {inDevelopment.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-amber" />
            {inDevelopment.length} in development
          </span>
        )}
        {planned.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-ink-faint/50" />
            {planned.length} planned
          </span>
        )}
      </div>

      {/* Available */}
      <section className="mt-9" aria-label="Available Minds">
        <h2 className="x-label !mt-0">Available now</h2>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {available.map((mind) => (
            <article
              key={mind.slug}
              className="flex flex-col justify-between rounded-xl border border-edge bg-panel p-5 transition-colors duration-200 hover:border-edge-strong"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] leading-relaxed text-ink-faint">{mind.domain}</p>
                  <MindStatusChip status={mind.status} />
                </div>
                <h3 className="mt-2.5 text-[16.5px] font-semibold leading-snug tracking-tight text-ink">
                  <Link href={`/minds/${mind.slug}`} className="transition-colors hover:text-teal">
                    {mind.name}
                  </Link>
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{mind.summary}</p>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-edge pt-3">
                {mind.href ? (
                  <Link
                    href={mind.href}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal transition-colors hover:text-ink"
                  >
                    {mind.slug === "index-reconstitution-desk" ? "Open the desk" : "Open"}
                    <ArrowRight size={12} aria-hidden />
                  </Link>
                ) : (
                  <Link
                    href={`/minds/${mind.slug}`}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal transition-colors hover:text-ink"
                  >
                    Run it <ArrowRight size={12} aria-hidden />
                  </Link>
                )}
                <Link
                  href={`/minds/${mind.slug}`}
                  className="text-[11.5px] text-ink-faint transition-colors hover:text-ink"
                >
                  Profile
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* In development */}
      {inDevelopment.length > 0 && (
        <section className="mt-10" aria-label="Minds in development">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="x-label !mt-0">In development</h2>
            <span className="text-[11px] text-ink-faint">Verified routes · no launch path</span>
          </div>
          <div className="mt-2 border-t border-edge">
            {inDevelopment.map((mind) => {
              const dims = CAPABILITIES[mind.slug]?.dimensions ?? [];
              const routes = dims.filter((d) => d.status !== "gap").length;
              const gaps = dims.filter((d) => d.status === "gap").length;
              return (
                <Link
                  key={mind.slug}
                  href={`/minds/${mind.slug}`}
                  className="group flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-edge py-4 transition-colors hover:bg-panel/50 sm:px-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[14.5px] font-medium text-ink transition-colors group-hover:text-teal">
                        {mind.name}
                      </span>
                    </span>
                    <span className="mt-1 block max-w-[72ch] text-[12.5px] leading-relaxed text-ink-soft">
                      {mind.summary}
                    </span>
                  </span>
                  <span className="text-right text-[11px] leading-relaxed text-ink-faint">
                    <span className="block">{mind.domain}</span>
                    <span className="tabular mt-0.5 block">
                      {routes} routes · {gaps} {gaps === 1 ? "gap" : "gaps"}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Planned */}
      {planned.length > 0 && (
        <section className="mt-10" aria-label="Planned Minds">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="x-label !mt-0">Planned</h2>
            <span className="text-[11px] text-ink-faint">Domains defined · not built</span>
          </div>
          <div className="mt-2 grid border-t border-edge sm:grid-cols-2 sm:gap-x-8">
            {planned.map((mind) => (
              <Link
                key={mind.slug}
                href={`/minds/${mind.slug}`}
                className="group flex items-baseline gap-3 border-b border-edge py-3 transition-colors hover:bg-panel/50 sm:px-1"
              >
                <span className="tabular w-5 shrink-0 text-[10.5px] text-ink-faint">{mindIndex(mind.slug)}</span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] text-ink transition-colors group-hover:text-teal">
                    {mind.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{mind.domain}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Shared foundation */}
      <section id="foundation" className="mt-12 scroll-mt-20 border-t border-edge pt-8" aria-label="Shared foundation">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr] lg:gap-10">
          <div>
            <p className="x-eyebrow">SHARED FOUNDATION</p>
            <h2 className="mt-2.5 text-[20px] font-semibold leading-tight tracking-tight text-ink">
              One engine. Every specialist.
            </h2>
            <p className="mt-2.5 max-w-[44ch] text-[12.5px] leading-relaxed text-ink-soft">
              A Mind adds its domain model. Investigation lifecycle, routing, approval, evidence and history are
              already shared, so a new domain is a definition and a plan — not another platform.
            </p>
          </div>
          <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {MIND_FOUNDATION.map((pillar) => (
              <li key={pillar.id} className="flex items-baseline justify-between gap-3 border-b border-edge/70 pb-2">
                <span className="text-[12px] text-ink-soft">{pillar.name}</span>
                <span className="whitespace-nowrap text-[10px] text-ink-faint">
                  {pillar.state === "ready" ? "Ready" : "Partial"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <p className="mt-8 text-[11px] leading-relaxed text-ink-faint">
        {MINDS.length} specialists defined. Every Mind here runs on the same shared engine: free preflights are open,
        paid answers wait at the operator approval gate, and each profile names what it will not claim.
      </p>
    </div>
  );
}
