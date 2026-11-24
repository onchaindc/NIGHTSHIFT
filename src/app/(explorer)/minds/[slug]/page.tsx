import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CircleAlert } from "lucide-react";

import { MINDS, MIND_STATUS_LABEL, mindBySlug, mindIndex } from "@/lib/minds/registry";
import { MIND_FOUNDATION, MIND_PIPELINE } from "@/lib/minds/foundation";
import { MindStatusChip } from "@/components/minds/status-chip";

interface Params {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return MINDS.map((mind) => ({ slug: mind.slug }));
}

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const mind = mindBySlug(slug);
  if (!mind) return { title: "Mind not found" };
  return {
    title: mind.name,
    description: `${mind.summary} ${MIND_STATUS_LABEL[mind.status]}.`,
  };
}

/**
 * A Mind's profile. It states the domain, the problem, what the Mind is
 * responsible for, its boundaries and its real development status. Only an
 * available Mind gets a launch action; the rest say plainly that they cannot
 * be run yet.
 */
export default async function MindProfilePage({ params }: Params) {
  const { slug } = await params;
  const mind = mindBySlug(slug);
  if (!mind) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-12">
      <Link
        href="/minds"
        className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink"
      >
        <ArrowLeft size={12} aria-hidden /> All Minds
      </Link>

      <header className="mt-5 border-b border-edge pb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="x-tag !mt-0">
            MINDS · {mind.domain.toUpperCase()} · {mindIndex(mind.slug)}
          </p>
          <MindStatusChip status={mind.status} />
        </div>
        <h1 className="x-display-1 mt-3 max-w-[24ch] text-ink">{mind.name}</h1>
        <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">{mind.summary}</p>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1.5fr_1fr] lg:gap-12">
        <div className="space-y-9">
          <section aria-labelledby="problem">
            <h2 id="problem" className="x-label !mt-0">The problem</h2>
            <p className="mt-2 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-soft">{mind.problem}</p>
          </section>

          <section aria-labelledby="responsibilities">
            <h2 id="responsibilities" className="x-label !mt-0">What it investigates</h2>
            <ol className="mt-2 space-y-3">
              {mind.responsibilities.map((item, i) => (
                <li key={item} className="grid grid-cols-[26px_1fr] gap-3">
                  <span className="tabular pt-0.5 text-[11px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-[13px] leading-relaxed text-ink">{item}</span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="uses">
            <h2 id="uses" className="x-label !mt-0">Business uses</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {mind.capabilities.map((c) => (
                <li
                  key={c}
                  className="rounded-full border border-edge bg-panel px-3 py-1 text-[11.5px] text-ink-soft"
                >
                  {c}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="boundaries">
            <h2 id="boundaries" className="x-label !mt-0">Boundaries</h2>
            <ul className="mt-2 space-y-2">
              {mind.boundaries.map((b) => (
                <li key={b} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
                  <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0 text-ink-faint" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-edge bg-panel p-5" aria-labelledby="status">
            <h2 id="status" className="x-label !mt-0">Development status</h2>
            <div className="mt-2.5">
              <MindStatusChip status={mind.status} />
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">{mind.statusNote}</p>

            {mind.status === "available" && mind.href ? (
              <div className="mt-4 border-t border-edge pt-4">
                <Link href={mind.href} className="btn-primary !min-h-9 w-full justify-center">
                  Open the investigation
                  <ArrowRight size={13} aria-hidden />
                </Link>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                  Runs on the shared engine. Free work is open; paid asks need an operator approval.
                </p>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-edge bg-panel-2 px-3 py-2.5">
                <p className="text-[11.5px] leading-relaxed text-ink-faint">
                  This Mind is not operational. There is no launch action because no investigation path exists
                  yet — not because it is hidden.
                </p>
              </div>
            )}

            <div className="mt-4 border-t border-edge pt-4">
              <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Next step</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{mind.nextStep}</p>
            </div>
          </section>

          {mind.coverage && (
            <section className="rounded-xl border border-edge bg-panel p-5" aria-labelledby="coverage">
              <h2 id="coverage" className="x-label !mt-0">Verified coverage</h2>
              <ul className="mt-2 divide-y divide-edge">
                {mind.coverage.map((c) => (
                  <li key={c.intent} className="py-2">
                    <p className="text-[12px] text-ink">{c.dimension}</p>
                    <p className="tabular mt-0.5 break-words text-[10.5px] text-ink-faint">
                      {c.intent} <span className="text-ink-soft">@ {c.miner}</span>
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Each intent was probed live and priced before integration.
              </p>
            </section>
          )}
        </aside>
      </div>

      {/* Shared foundation */}
      <section className="mt-12 border-t border-edge pt-8" aria-labelledby="pipeline">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="pipeline" className="x-label !mt-0">The run every Mind shares</h2>
          <Link href="/minds#foundation" className="text-[11.5px] text-teal hover:underline">
            What is already built
          </Link>
        </div>
        <ol className="mt-3 grid gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2 lg:grid-cols-4">
          {MIND_PIPELINE.map((stage, i) => (
            <li key={stage.id} className="bg-panel px-4 py-3.5">
              <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                <span className="tabular">{String(i + 1).padStart(2, "0")}</span>
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${stage.state === "ready" ? "bg-teal" : "bg-amber"}`}
                />
                {stage.state === "ready" ? "Ready" : "Partial"}
              </p>
              <p className="mt-1.5 text-[12.5px] font-medium text-ink">{stage.name}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{stage.detail}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 max-w-[80ch] text-[11.5px] leading-relaxed text-ink-faint">
          {mind.status === "available"
            ? "This Mind runs on the shared task engine, operator approval gate, x402 payment rail, signal verification and persistent history."
            : "When this Mind is built, it will use the shared task engine, approval gate, x402 payment rail, verification and history rather than new infrastructure."}{" "}
          {MIND_FOUNDATION.filter((p) => p.state === "partial").length > 0
            ? "Monitoring is the one pillar still partial: Protocol Watch schedules checks, per-Mind follow-ups are not built."
            : null}
        </p>
      </section>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-5">
        <Link href="/minds" className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink">
          <ArrowLeft size={12} aria-hidden /> Back to the catalogue
        </Link>
        {mind.status === "available" && mind.href ? (
          <Link href={mind.href} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal hover:underline">
            Open {mind.name} <ArrowRight size={12} aria-hidden />
          </Link>
        ) : (
          <span className="text-[11.5px] text-ink-faint">Not yet available</span>
        )}
      </div>
    </div>
  );
}
