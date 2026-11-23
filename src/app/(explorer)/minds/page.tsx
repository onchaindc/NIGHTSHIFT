import Link from "next/link";
import { ArrowRight, BadgeCheck, Building2, Lock, Sparkles } from "lucide-react";

export const metadata = { title: "Minds" };

/**
 * The Minds index. A Mind is a pinned specialist ask — one provider, one
 * published price, one verifiable answer — and this page is the catalog
 * people choose from. Only specialists that are actually live are listed as
 * available; everything else is stated as in development rather than
 * advertised as a capability that does not exist yet.
 */
export default function MindsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="x-eyebrow">NIGHTSHIFT MINDS</p>
          <h1 className="x-display-1 mt-3 max-w-[18ch] text-ink">Specialists, paid per answer.</h1>
          <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-ink-soft">
            Each Mind is one pinned specialist with a published price — not a router guess. You see the
            exact offer before anything is signed, and the answer you read is the hash-committed one.
          </p>
        </div>
        <p className="inline-flex items-center gap-2 rounded-full border border-edge bg-panel px-3.5 py-2 text-[12px] text-ink-soft">
          <span aria-hidden className="size-1.5 rounded-full bg-teal" />
          1 available
          <span aria-hidden className="text-ink-faint">·</span>
          <span className="text-ink-faint">more in development</span>
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/minds/counterparty"
          className="group flex flex-col rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal/60 hover:shadow-[0_14px_40px_-28px_rgba(15,118,110,0.55)]"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-teal/10 text-teal ring-1 ring-teal/15">
              <Building2 size={19} strokeWidth={1.8} aria-hidden />
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/25 bg-teal/5 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-teal">
              <span aria-hidden className="size-1 rounded-full bg-teal" />
              Available
            </span>
          </div>
          <h2 className="mt-5 text-[17px] font-semibold tracking-tight text-ink">Counterparty intelligence</h2>
          <p className="mt-2 flex-1 text-[13px] leading-relaxed text-ink-soft">
            Corporate-registry facts for a named company: legal name, registration ID, LEI, active
            status, registered address and more — split into facts, gaps and conflicts.
          </p>
          <div className="mt-5 flex items-end justify-between gap-3 border-t border-edge pt-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">From</p>
              <p className="tabular mt-0.5 text-[13px] font-medium text-ink">$0.01 / ask</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-teal transition-transform duration-200 group-hover:translate-x-0.5">
              Open
              <ArrowRight size={13} aria-hidden />
            </span>
          </div>
        </Link>

        <div className="flex flex-col rounded-2xl border border-dashed border-edge bg-panel/40 p-5">
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-panel-3 text-ink-faint ring-1 ring-edge">
              <Sparkles size={19} strokeWidth={1.7} aria-hidden />
            </span>
            <span className="inline-flex items-center rounded-full border border-edge bg-panel px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              In development
            </span>
          </div>
          <h2 className="mt-5 text-[17px] font-semibold tracking-tight text-ink-soft">More specialists</h2>
          <p className="mt-2 flex-1 text-[13px] leading-relaxed text-ink-faint">
            Each new Mind appears here with its provider and its price before it goes live. Nothing is
            listed until it can answer.
          </p>
          <div className="mt-5 border-t border-edge/70 pt-4 text-[11.5px] text-ink-faint">
            Added one at a time
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-edge bg-edge sm:grid-cols-3">
        {[
          {
            icon: Building2,
            title: "One named provider",
            body: "A Mind pins one specialist and its endpoint, so you know exactly who is answering.",
          },
          {
            icon: Lock,
            title: "You approve the offer",
            body: "The exact price and recipient are shown before anything is signed. No offer, no charge.",
          },
          {
            icon: BadgeCheck,
            title: "Verified, not just received",
            body: "Facts come from the hash-committed payload; missing fields stay missing.",
          },
        ].map((item) => (
          <div key={item.title} className="bg-panel p-5">
            <item.icon size={17} strokeWidth={1.7} aria-hidden className="text-teal" />
            <p className="mt-3 text-[13px] font-semibold text-ink">{item.title}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
