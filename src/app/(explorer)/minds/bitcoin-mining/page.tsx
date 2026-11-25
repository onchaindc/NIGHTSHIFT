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
    probedAt: CAPABILITY_PROBED_AT,
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Link href="/minds" className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink">
        <ArrowLeft size={12} aria-hidden /> All Minds
      </Link>

      <header className="mt-5 border-b border-edge pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="x-tag !mt-0">MINDS · DIGITAL ASSETS · BITCOIN MINING</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/25 bg-teal/5 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-teal">
            <span aria-hidden className="size-1 rounded-full bg-teal" /> Operational
          </span>
        </div>
        <h1 className="x-display-1 mt-3 max-w-[24ch] text-ink">Mine economics, evidenced.</h1>
        <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-soft">
          Pick a block, grid zone and settlement interval, then run — the report lands right below, with its evidence and gaps attached.
        </p>
      </header>

      <BitcoinMiningClient guarantees={guarantees} />
    </div>
  );
}
