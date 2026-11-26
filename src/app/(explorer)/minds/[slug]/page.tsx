import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowDown, ArrowRight, ChevronDown, CircleAlert } from "lucide-react";

import { MINDS, MIND_STATUS_LABEL, mindBySlug, mindIndex } from "@/lib/minds/registry";
import {
  CAPABILITIES,
  CAPABILITY_PROBED_AT,
  type CapabilityDimension,
} from "@/lib/minds/capabilities";
import { PROBE_STATUS_DOT, PROBE_STATUS_WORD } from "@/components/minds/status-chip";
import { MindStatusChip } from "@/components/minds/status-chip";
import CapabilityConsole, { type ConsoleDimensionView } from "@/components/minds/capability-console";

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

function fmtUsd(cents: number | undefined): string {
  return `$${((cents ?? 1) / 100).toFixed(2)}`;
}

/**
 * A Mind's profile, rebuilt for focus: a slim hero, the run console first,
 * and everything editorial compressed. The full capability matrix and the
 * run plan live in a collapsed <details> for anyone who wants the audit
 * detail — the page leads with what the Mind does, not what we can say
 * about it.
 */
export default async function MindProfilePage({ params }: Params) {
  const { slug } = await params;
  const mind = mindBySlug(slug);
  if (!mind) notFound();

  const caps = CAPABILITIES[mind.slug];
  const routable = caps?.dimensions.filter((d) => d.status !== "gap") ?? [];
  const gapDims = caps?.dimensions.filter((d) => d.status === "gap") ?? [];

  const consoleDimensions: ConsoleDimensionView[] = routable.map((d) => ({
    id: d.id,
    label: d.label,
    requirement: d.requirement,
    status: d.status,
    intent: d.intent,
    provider: d.provider,
    viaRouterFallback: d.viaRouterFallback === true,
    priceUsdCents: d.priceUsdCents,
    params: Object.entries(d.params ?? {}).map(([name, spec]) => ({
      name,
      required: spec.required,
      description: spec.description,
      ...(spec.sample !== undefined ? { sample: spec.sample } : {}),
    })),
  }));
  const ceiling = routable.reduce((sum, d) => sum + (d.priceUsdCents ?? 1), 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link href="/minds" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
        <ArrowLeft size={12} aria-hidden /> All Minds
      </Link>

      {/* Slim hero: name, one line, status, three stats */}
      <header className="mt-5 border-b border-edge pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="x-tag !mt-0">
            MINDS · {mind.domain.toUpperCase()} · {mindIndex(mind.slug)}
          </p>
          <MindStatusChip status={mind.status} />
        </div>
        <h1 className="x-display-1 mt-3 max-w-[24ch] text-ink">{mind.name}</h1>
        <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">{mind.summary}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-faint">
          <span>
            <span className="tabular font-medium text-ink">{routable.length}</span> live routes
          </span>
          <span aria-hidden className="text-edge">·</span>
          <span>
            paid ceiling <span className="tabular font-medium text-ink">{fmtUsd(ceiling)}</span>
          </span>
          <span aria-hidden className="text-edge">·</span>
          <span>free preflight open · paid runs need your approval</span>
        </div>
      </header>

      {/* The console — first thing on the page. Minds with a bespoke route
          point at it instead; they never get a second, duplicate run surface. */}
      {mind.href ? (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal/25 bg-teal/5 px-4 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            This Mind runs on its own investigation console with its full history and dossier.
          </p>
          <Link href={mind.href} className="btn-primary !min-h-9">
            Open the investigation
            <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      ) : consoleDimensions.length > 0 ? (
        <div id="run" className="scroll-mt-6">
          <CapabilityConsole
            slug={mind.slug}
            name={mind.name}
            mindStatus={mind.status}
            ceilingUsdCents={ceiling}
            dimensions={consoleDimensions}
            probedAt={CAPABILITY_PROBED_AT}
          />
        </div>
      ) : (
        <p className="mt-8 rounded-xl border border-dashed border-edge bg-panel-2 px-4 py-8 text-center text-[12.5px] text-ink-faint">
          No routable dimension is defined for this Mind yet.
        </p>
      )}

      {/* Scope & limits — compact, two columns */}
      <section className="mt-8 grid gap-8 border-t border-edge pt-6 lg:grid-cols-2" aria-label="Scope and limits">
        <div>
          <h2 className="x-label !mt-0">What it investigates</h2>
          <ul className="mt-2.5 space-y-2">
            {mind.responsibilities.map((item) => (
              <li key={item} className="text-[12.5px] leading-relaxed text-ink-soft">{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="x-label !mt-0">What it will not claim</h2>
          <ul className="mt-2.5 space-y-2">
            {mind.boundaries.map((b) => (
              <li key={b} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
                <CircleAlert size={13} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0 text-ink-faint" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Coverage detail — collapsed until asked for */}
      {caps && (
        <details className="group mt-6 rounded-xl border border-edge bg-panel">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
            <span className="text-[13px] font-medium text-ink">
              Coverage detail — {routable.length} routes, {gapDims.length} unsupported
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              intent codes, prices, run plan
              <ChevronDown size={13} aria-hidden className="transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="border-t border-edge px-4 py-4 sm:px-5">
            <p className="text-[11px] text-ink-faint">
              Probed unpaid {CAPABILITY_PROBED_AT.slice(0, 10)} · no payment signed. Unsupported dimensions are named, not
              filled with a loosely related intent.
            </p>
            <ul className="mt-3 border-t border-edge">
              {[...routable, ...gapDims].map((d) => (
                <li key={d.id} className="grid gap-1.5 border-b border-edge py-3 sm:grid-cols-[10px_1fr_auto] sm:items-baseline sm:gap-3">
                  <span aria-hidden className={`mt-1.5 size-1.5 rounded-full ${PROBE_STATUS_DOT[d.status]}`} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-[13px] font-medium text-ink">{d.label}</span>
                      <span className="text-[10.5px] text-ink-faint">{PROBE_STATUS_WORD[d.status]}</span>
                    </p>
                    {d.status === "gap" ? (
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-soft">
                        {d.missingReason}
                        {d.resolution ? <span className="mt-0.5 block">Route to close: {d.resolution}</span> : null}
                      </p>
                    ) : (
                      <p className="mt-0.5 break-words text-[10.5px] text-ink-faint">
                        <span className="tabular">{d.intent}</span> · {d.provider}
                        {d.viaRouterFallback && (
                          <span className="ml-1.5 inline-flex items-center rounded border border-amber/40 bg-amber-soft/50 px-1 py-px text-[9.5px] font-medium text-amber-deep">router fallback</span>
                        )}
                        {d.limitation ? <> — {d.limitation}</> : null}
                      </p>
                    )}
                  </div>
                  <span className="tabular text-[11px] text-ink-faint">{d.status === "gap" ? "—" : fmtUsd(d.priceUsdCents)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Run plan</p>
                <ol className="mt-1.5 space-y-1">
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
                <p className="text-[11.5px] leading-relaxed text-ink-soft">{caps.plan.approvalGate}</p>
                <p className="text-[11.5px] leading-relaxed text-ink-soft">{caps.plan.verification}</p>
              </div>
            </div>
            {caps.plan.exclusions.length > 0 && (
              <p className="mt-3 border-t border-edge pt-3 text-[11.5px] leading-relaxed text-ink-soft">
                <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">Not in this plan </span>
                {caps.plan.exclusions.join(" · ")}
              </p>
            )}
          </div>
        </details>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-5">
        <Link href="/minds" className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink">
          <ArrowLeft size={12} aria-hidden /> Back to the catalogue
        </Link>
        {consoleDimensions.length > 0 && (
          <a href="#run" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal hover:underline">
            Run {mind.name} <ArrowDown size={12} aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}
