import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

import BitcoinMiningClient, {
  type BitcoinDimensionView,
  type BitcoinMiningGuarantees,
} from "@/components/bitcoinmining/bitcoin-mining-client";
import { CAPABILITIES, CAPABILITY_PROBED_AT } from "@/lib/minds/capabilities";
import { mindBySlug } from "@/lib/minds/registry";
import { telegraphNodeUrl } from "@/lib/telegraph/client";

export const metadata = {
  title: "Bitcoin Mining Intelligence",
  description:
    "An evidence-backed Bitcoin mining economics investigation over hashprice, BTC price and ERCOT power price.",
};

export const dynamic = "force-dynamic";

export default function BitcoinMiningPage() {
  const mind = mindBySlug("bitcoin-mining-intelligence");
  if (!mind) throw new Error("Bitcoin Mining Intelligence is not registered");
  const caps = CAPABILITIES["bitcoin-mining-intelligence"];

  const dimensions: BitcoinDimensionView[] = (caps?.dimensions ?? []).map((d) => ({
    id: d.id,
    label: d.label,
    requirement: d.requirement,
    status: d.status,
    intent: d.intent,
    provider: d.provider,
    priceUsdCents: d.priceUsdCents,
    limitation: d.limitation,
    missingReason: d.missingReason,
    resolution: d.resolution,
  }));

  const guarantees: BitcoinMiningGuarantees = {
    nodeUrl: telegraphNodeUrl(),
    ceilingUsdCents: caps?.plan.budgetCeilingUsdCents ?? 3,
    dimensions,
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link href="/minds" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
        <ArrowLeft size={12} aria-hidden /> All Minds
      </Link>

      <header className="mt-5 border-b border-edge pb-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="x-tag !mt-0">MINDS · DIGITAL ASSETS · BITCOIN MINING</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/25 bg-teal/5 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-teal">
            <span aria-hidden className="size-1 rounded-full bg-teal" /> Operational
          </span>
        </div>
        <h1 className="x-display-1 mt-3 max-w-[24ch] text-ink">Mine economics, evidenced.</h1>
        <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">
          Set the block, grid zone and settlement interval. NIGHTSHIFT prices the three verified mining dimensions for free,
          waits for your approval, buys one signal-verified answer from each, and produces a mining-economics report with the
          evidence and the two remaining gaps attached.
        </p>
      </header>

      <div className="mt-6 grid gap-px overflow-hidden rounded-xl border border-edge bg-edge sm:grid-cols-3">
        {[
          { n: "01", title: "Objective", body: "A block, an ERCOT hub and the exact settlement interval." },
          { n: "02", title: "Approval", body: "Free probes price three asks. Nothing is signed until you approve the $0.03 ceiling." },
          { n: "03", title: "Report", body: "Hashprice, BTC, LMP, break-even efficiency, hashes and named gaps." },
        ].map((step) => (
          <div key={step.n} className="bg-panel px-4 py-3">
            <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              <span className="grid size-5 place-items-center rounded-full bg-panel-3 text-[10px] font-semibold text-ink-soft">{step.n}</span>
              {step.title}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{step.body}</p>
          </div>
        ))}
      </div>

      <BitcoinMiningClient guarantees={guarantees} />

      <section className="mt-8 rounded-xl border border-edge bg-panel p-5">
        <p className="x-label !mt-0">Method</p>
        <p className="mt-2 max-w-[78ch] text-[12.5px] leading-relaxed text-ink-soft">
          Each ask settles through Telegraph x402 only after the engine approval gate. The committed payload is re-derived
          against its node signal; a mismatch is recorded, never smoothed over. The provider&apos;s hashprice answer carries sats
          and hashrate but explicitly leaves USD unavailable, so the report multiplies that committed sats value by the separately
          committed BTC spot price and labels the result as a derivation.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-ink-faint">
          <span>Three routes probed unpaid {CAPABILITY_PROBED_AT.slice(0, 10)}</span>
          <span>Paid path exercised 2026-11-24</span>
          <Link href="/minds/bitcoin-mining-intelligence" className="inline-flex items-center gap-1 text-ink-soft transition-colors hover:text-teal">
            Full coverage profile <ArrowRight size={11} aria-hidden />
          </Link>
        </div>
      </section>
    </div>
  );
}
