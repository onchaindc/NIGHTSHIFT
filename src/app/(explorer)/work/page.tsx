import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Handshake, ShieldCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Two distinct workspaces: the Deal Desk for specialised investigations and Assurance for settlement-grade transaction files — one evidence engine, explicit provenance, named gaps.",
};

/**
 * The Work hub: navigation architecture only. It exposes the two clearly
 * distinct workspaces without merging or redesigning them — each card opens
 * the workspace's own homepage, which keeps its full existing UI.
 */
export default function WorkPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-[56ch]">
        <p className="x-eyebrow">Work</p>
        <h1 className="x-display-1 mt-3 text-balance text-ink">Two workspaces, one evidence engine.</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
          Pick the desk that matches the decision. Both keep the same rules: every verified fact carries its
          provenance, every gap is named, and nothing is spent without an explicit approval.
        </p>
      </header>

      <section aria-label="Workspaces" className="mt-8 grid gap-4">
        <Link
          href="/desk"
          className="group flex flex-col rounded-2xl border border-edge bg-panel p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
        >
          <span className="w-fit rounded-full border border-teal/30 bg-teal/10 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-teal">
            Deal Desk
          </span>
          <h2 className="mt-3 flex items-center gap-2 text-[17px] font-semibold text-ink">
            <Handshake size={17} aria-hidden className="text-teal" />
            Specialised investigations
          </h2>
          <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-soft">
            Four guided investigation workflows — Counterparty Due Diligence, Asset Intelligence, Trade &amp;
            Supplier Intelligence and Listing Underwriter — opened as investigation files with an evidence ledger,
            paid runs behind an approval gate and a confidence-rated report.
          </p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft transition-colors group-hover:text-ink">
            Open the Deal Desk <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>

        <Link
          href="/assurance"
          className="group flex flex-col rounded-2xl border border-edge bg-panel p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
        >
          <span className="w-fit rounded-full border border-amber/30 bg-amber/10 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-amber">
            Assurance
          </span>
          <h2 className="mt-3 flex items-center gap-2 text-[17px] font-semibold text-ink">
            <ShieldCheck size={17} aria-hidden className="text-amber" />
            Settlement files
          </h2>
          <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-soft">
            Open a file on a high-value payment before you settle it: counterparties, ownership, sanctions
            exposure, documents and obligations — one CLEARED / HOLD / ESCALATE decision with every finding cited,
            plus the settlement bundle hand-off.
          </p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft transition-colors group-hover:text-ink">
            Open Assurance <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      </section>

      <p className="mt-8 text-[11px] leading-relaxed text-ink-faint">
        Missing evidence stays missing — it is never inferred. Old links keep working: /desk/:id resolves Deal Desk
        investigations and Assurance settlement files by their stored record type.
      </p>
    </div>
  );
}
