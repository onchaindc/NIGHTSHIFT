import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CircleAlert } from "lucide-react";

import { MINDS, MIND_STATUS_LABEL, mindBySlug, mindIndex } from "@/lib/minds/registry";
import {
  CAPABILITIES,
  CAPABILITY_PROBED_AT,
  READINESS_LABEL,
  readinessFor,
  type CapabilityDimension,
} from "@/lib/minds/capabilities";
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

const STATUS_TONE: Record<CapabilityDimension["status"], string> = {
  verified: "bg-teal",
  partial: "bg-amber",
  gap: "bg-ink-faint/40",
};

const STATUS_WORD: Record<CapabilityDimension["status"], string> = {
  verified: "Route verified",
  partial: "Partial",
  gap: "Unsupported",
};

/**
 * A Mind's profile. It separates three facts that are easy to blur:
 * the Mind's product status (available / in development), the network's
 * verified coverage (schema, provider and price), and whether output has
 * actually been exercised. Only an available Mind gets a launch action.
 */
export default async function MindProfilePage({ params }: Params) {
  const { slug } = await params;
  const mind = mindBySlug(slug);
  if (!mind) notFound();

  const caps = CAPABILITIES[mind.slug];
  const readiness = readinessFor(mind.slug, mind.status);
  const verified = caps?.dimensions.filter((d) => d.status === "verified").length ?? 0;
  const partial = caps?.dimensions.filter((d) => d.status === "partial").length ?? 0;
  const gaps = caps?.dimensions.filter((d) => d.status === "gap").length ?? 0;

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
        <p className="mt-3 text-[11.5px] text-ink-faint">
          {READINESS_LABEL[readiness]} · {verified} verified {verified === 1 ? "route" : "routes"}
          {partial > 0 ? ` · ${partial} partial` : ""}
          {gaps > 0 ? ` · ${gaps} ${gaps === 1 ? "gap" : "gaps"}` : ""}
        </p>
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
                <li key={c} className="rounded-full border border-edge bg-panel px-3 py-1 text-[11.5px] text-ink-soft">
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
                  This Mind is not operational. There is no launch action because coverage is incomplete and no paid
                  answer has been verified for it; the shared capability API can still execute its verified
                  dimensions.
                </p>
              </div>
            )}

            <div className="mt-4 border-t border-edge pt-4">
              <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Next step</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{mind.nextStep}</p>
            </div>
          </section>

          <section className="rounded-xl border border-edge bg-panel p-5" aria-labelledby="readiness">
            <h2 id="readiness" className="x-label !mt-0">Network readiness</h2>
            <dl className="mt-2 space-y-2 text-[12px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Verified routes</dt>
                <dd className="tabular text-ink">{verified}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Partial</dt>
                <dd className="tabular text-ink">{partial}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Unsupported</dt>
                <dd className="tabular text-ink">{gaps}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t border-edge pt-3 text-[11px] leading-relaxed text-ink-faint">
              {readiness === "operational"
                ? "This Mind has a live investigation path; verified dimensions below are part of it."
                : "Verified means the node accepted the canonical schema, pinned provider and live price. It does not mean a paid answer exists."}
            </p>
          </section>
        </aside>
      </div>

      {/* Capability matrix */}
      <section className="mt-12 border-t border-edge pt-8" aria-labelledby="coverage">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="coverage" className="x-label !mt-0">Network coverage</h2>
          <span className="text-[11px] text-ink-faint">
            Probed unpaid {CAPABILITY_PROBED_AT.slice(0, 10)} · no payment signed
          </span>
        </div>
        <p className="mt-2 max-w-[82ch] text-[12px] leading-relaxed text-ink-soft">
          Every supported dimension below was checked against the live Telegraph catalogue and probed with its
          canonical request body. Unsupported dimensions are named, not filled with a loosely related intent.
        </p>

        {caps ? (
          <>
            <ul className="mt-4 border-t border-edge">
              {caps.dimensions.map((dim) => (
                <li key={dim.id} className="grid gap-1.5 border-b border-edge py-3.5 sm:grid-cols-[10px_1fr_auto] sm:items-baseline sm:gap-3">
                  <span aria-hidden className={`mt-1.5 size-1.5 rounded-full ${STATUS_TONE[dim.status]}`} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-[13px] font-medium text-ink">{dim.label}</span>
                      <span className="text-[10.5px] text-ink-faint">{STATUS_WORD[dim.status]}</span>
                    </p>
                    <p className="mt-0.5 max-w-[80ch] text-[12px] leading-relaxed text-ink-soft">{dim.requirement}</p>
                    <p className="mt-1 break-words text-[10.5px] text-ink-faint">
                      {dim.status === "gap" ? (
                        <span>Why it is unsupported: {dim.missingReason}</span>
                      ) : (
                        <>
                          <span className="tabular">{dim.intent}</span> · {dim.provider}
                          {dim.limitation ? <span> — {dim.limitation}</span> : null}
                        </>
                      )}
                    </p>
                  </div>
                  <span className="tabular text-[11px] text-ink-faint">
                    {dim.status === "gap" ? "—" : `$${((dim.priceUsdCents ?? 1) / 100).toFixed(2)}`}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-6 rounded-xl border border-edge bg-panel p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[13.5px] font-medium text-ink">Investigation plan</h3>
                <span className="tabular text-[11px] text-ink-faint">
                  ceiling ${(caps.plan.budgetCeilingUsdCents / 100).toFixed(2)}
                </span>
              </div>
              <div className="mt-3 grid gap-5 sm:grid-cols-2">
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Execution order</p>
                  <ol className="mt-1.5 space-y-1.5">
                    {caps.plan.order.map((id, i) => {
                      const dim = caps.dimensions.find((d) => d.id === id);
                      return (
                        <li key={id} className="grid grid-cols-[20px_1fr] gap-2 text-[12px] text-ink-soft">
                          <span className="tabular text-[10.5px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                          <span>{dim?.label ?? id}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Approval gate</p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{caps.plan.approvalGate}</p>
                  </div>
                  <div>
                    <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Verification</p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{caps.plan.verification}</p>
                  </div>
                </div>
              </div>
              {caps.plan.exclusions.length > 0 && (
                <div className="mt-4 border-t border-edge pt-3">
                  <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Not in this plan</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{caps.plan.exclusions.join(" · ")}</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="mt-3 text-[12px] text-ink-faint">No capability matrix has been built for this Mind yet.</p>
        )}
      </section>

      {/* Shared foundation */}
      <section className="mt-10 border-t border-edge pt-8" aria-labelledby="pipeline">
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
                <span aria-hidden className={`size-1.5 rounded-full ${stage.state === "ready" ? "bg-teal" : "bg-amber"}`} />
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
