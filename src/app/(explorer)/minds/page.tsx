import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { MINDS, MIND_STATUS_LABEL, mindIndex, mindsByStatus } from "@/lib/minds/registry";
import { MIND_FOUNDATION } from "@/lib/minds/foundation";
import { MindStatusChip } from "@/components/minds/status-chip";

export const metadata = {
  title: "Minds",
  description:
    "NIGHTSHIFT Minds: ten specialist intelligence capabilities — from index reconstitution and mining economics to sanctions, ownership and trade — on one evidence and payment foundation.",
};

/**
 * The Minds catalogue. Every entry is drawn from the registry, so a Mind's
 * status, profile and launch path cannot drift between here and its own page.
 * Only a Mind with a live investigation path shows a launch action.
 */
export default function MindsPage() {
  const available = mindsByStatus("available");
  const inDevelopment = mindsByStatus("in_development");
  const planned = mindsByStatus("planned");

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="x-eyebrow">NIGHTSHIFT MINDS</p>
          <h1 className="x-display-1 mt-3 max-w-[20ch] text-ink">Specialist intelligence, one domain at a time.</h1>
          <p className="mt-4 max-w-[64ch] text-[14px] leading-relaxed text-ink-soft">
            Each Mind investigates a defined business domain with a pinned provider, a published price and an
            evidence trail. They share one engine — planning, approval, controlled spending, verification and
            history — so a new domain does not need a new platform.
          </p>
        </div>
        <p className="inline-flex flex-wrap items-center gap-2 rounded-full border border-edge bg-panel px-3.5 py-2 text-[12px] text-ink-soft">
          <span aria-hidden className="size-1.5 rounded-full bg-teal" />
          {available.length} available
          <span aria-hidden className="text-ink-faint">·</span>
          {inDevelopment.length} in development
          <span aria-hidden className="text-ink-faint">·</span>
          <span className="text-ink-faint">{planned.length} planned</span>
        </p>
      </div>

      {/* Available */}
      <section className="mt-10" aria-label="Available Minds">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="x-label !mt-0">Available now</h2>
          <span className="text-[11.5px] text-ink-faint">Live investigations</span>
        </div>

        {available.map((mind) => (
          <article key={mind.slug} className="mt-3 overflow-hidden rounded-xl border border-edge bg-panel">
            <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1.3fr_1fr] lg:gap-10">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="x-label !mt-0 tabular">{mindIndex(mind.slug)} · {mind.domain}</p>
                  <MindStatusChip status={mind.status} />
                </div>
                <h3 className="mt-3 text-[24px] font-semibold leading-tight tracking-tight text-ink sm:text-[27px]">
                  <Link href={`/minds/${mind.slug}`} className="transition-colors hover:text-teal">
                    {mind.name}
                  </Link>
                </h3>
                <p className="mt-2.5 max-w-[56ch] text-[13.5px] leading-relaxed text-ink-soft">{mind.summary}</p>
                <p className="mt-3 max-w-[56ch] text-[12px] leading-relaxed text-ink-faint">{mind.statusNote}</p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {mind.href && (
                    <Link href={mind.href} className="btn-primary !min-h-9">
                      Open the desk
                      <ArrowRight size={13} aria-hidden />
                    </Link>
                  )}
                  <Link href={`/minds/${mind.slug}`} className="btn-quiet !min-h-9">
                    Read the profile
                  </Link>
                </div>
              </div>

              {mind.coverage && (
                <div className="self-start rounded-lg border border-edge bg-panel-2">
                  <p className="x-label px-4 pt-3.5">Verified network coverage</p>
                  <ul className="mt-1 divide-y divide-edge px-4 pb-2">
                    {mind.coverage.map((c) => (
                      <li key={c.intent} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                        <span className="text-[12px] text-ink">{c.dimension}</span>
                        <span className="tabular min-w-0 break-words text-[10.5px] text-ink-faint">
                          {c.intent} <span className="text-ink-soft">@ {c.miner}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </article>
        ))}

        <Link
          href="/minds/counterparty"
          className="group mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-panel/60 px-4 py-3 transition-colors hover:border-teal/40"
        >
          <span className="text-[12.5px] text-ink-soft">
            <span className="font-medium text-ink">Also live: Counterparty intelligence</span> — corporate-registry
            facts for a named company, split into verified facts, gaps and conflicts.
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-teal transition-transform group-hover:translate-x-0.5">
            Open <ArrowRight size={12} aria-hidden />
          </span>
        </Link>
      </section>

      {/* In development */}
      {inDevelopment.length > 0 && (
        <section className="mt-12" aria-label="Minds in development">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="x-label !mt-0">In development</h2>
            <span className="text-[11.5px] text-ink-faint">Definition complete · no launch yet</span>
          </div>
          <div className="mt-3 border-t border-edge">
            {inDevelopment.map((mind) => (
              <Link
                key={mind.slug}
                href={`/minds/${mind.slug}`}
                className="group grid gap-2 border-b border-edge py-5 transition-colors hover:bg-panel/60 sm:grid-cols-[52px_1fr_auto] sm:items-baseline sm:gap-5 sm:px-1"
              >
                <span className="tabular text-[11px] text-ink-faint">{mindIndex(mind.slug)}</span>
                <span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[16px] font-medium text-ink transition-colors group-hover:text-teal">{mind.name}</span>
                    <MindStatusChip status={mind.status} />
                  </span>
                  <span className="mt-1 block max-w-[72ch] text-[12.5px] leading-relaxed text-ink-soft">{mind.summary}</span>
                  <span className="mt-1 block text-[11px] text-ink-faint">{mind.domain}</span>
                </span>
                <span className="text-[12px] font-medium text-teal">Profile →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Planned */}
      <section className="mt-12" aria-label="Planned Minds">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="x-label !mt-0">Planned</h2>
          <span className="text-[11.5px] text-ink-faint">{planned.length} domains defined</span>
        </div>
        <div className="mt-3 border-t border-edge">
          {planned.map((mind) => (
            <Link
              key={mind.slug}
              href={`/minds/${mind.slug}`}
              className="group grid gap-2 border-b border-edge py-4 transition-colors hover:bg-panel/60 sm:grid-cols-[52px_1fr_auto] sm:items-baseline sm:gap-5 sm:px-1"
            >
              <span className="tabular text-[11px] text-ink-faint">{mindIndex(mind.slug)}</span>
              <span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-medium text-ink transition-colors group-hover:text-teal">{mind.name}</span>
                  <MindStatusChip status={mind.status} />
                </span>
                <span className="mt-1 block max-w-[78ch] text-[12.5px] leading-relaxed text-ink-soft">{mind.summary}</span>
                <span className="mt-0.5 block text-[11px] text-ink-faint">{mind.domain}</span>
              </span>
              <span className="text-[12px] font-medium text-teal">Profile →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Shared foundation */}
      <section id="foundation" className="mt-14 scroll-mt-20 border-t border-edge pt-9" aria-label="Shared foundation">
        <div className="grid gap-7 lg:grid-cols-[1fr_1.35fr] lg:gap-12">
          <div>
            <p className="x-eyebrow">SHARED FOUNDATION</p>
            <h2 className="mt-3 max-w-[22ch] text-[22px] font-semibold leading-tight tracking-tight text-ink">
              One engine. Every specialist.
            </h2>
            <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-ink-soft">
              A Mind adds its domain model — the inputs it needs, the dimensions it verifies, the rules it applies.
              Investigation lifecycle, routing, approval, evidence and history are already shared, so each new
              Mind is a definition and a plan, not another platform.
            </p>
            <p className="mt-3 text-[11.5px] text-ink-faint">
              Monitoring is partly built: Protocol Watch schedules source checks; per-Mind follow-ups are next.
            </p>
          </div>
          <ul className="grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2">
            {MIND_FOUNDATION.map((pillar) => (
              <li key={pillar.id} className="bg-panel px-4 py-3.5">
                <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${pillar.state === "ready" ? "bg-teal" : "bg-amber"}`}
                  />
                  {pillar.name}
                </p>
                <p className="mt-1 text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                  {pillar.state === "ready" ? "Ready" : "Partial"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <p className="mt-10 text-[11.5px] text-ink-faint">
        {MINDS.length} Minds defined · statuses reflect what is implemented in this deployment, not a roadmap promise.
        A Mind shown as {MIND_STATUS_LABEL.in_development.toLowerCase()} or{" "}
        {MIND_STATUS_LABEL.planned.toLowerCase()} cannot be run.
      </p>
    </div>
  );
}
