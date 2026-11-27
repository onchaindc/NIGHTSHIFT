import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { MINDS, mindsByStatus } from "@/lib/minds/registry";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "The deployment at a glance: the Minds in service, the two workspaces, the Buyer Desk, the wallet, and the network behind the answers.",
};

/**
 * The Overview destination — a lean starting point for this phase, not the
 * full redesign: what exists on this deployment, what each surface does, and
 * where to enter it. Every line links to a real surface; no invented
 * features, no fabricated live data.
 */
export default function OverviewPage() {
  const available = mindsByStatus("available");
  const planned = MINDS.length - available.length;

  const entries = [
    {
      href: "/minds",
      label: "Minds",
      desc: "Specialist intelligence capabilities for decisions that carry consequence — one evidence and payment foundation.",
    },
    {
      href: "/work",
      label: "Work",
      desc: "Two distinct workspaces: the Deal Desk's specialised investigations and Assurance settlement files.",
    },
    {
      href: "/buyer",
      label: "Buyer Desk",
      desc: "Buy offerings with your own wallet on Base: configure, authorize, track and receive — with the full report on delivery.",
    },
    {
      href: "/funds",
      label: "Wallet",
      desc: "Balances, funding and spend standing for this deployment.",
    },
  ];

  const network = [
    { href: "/miners", label: "Miner catalog" },
    { href: "/signals", label: "Signals" },
    { href: "/activity", label: "Your activity" },
    { href: "/developers", label: "Developers" },
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-[56ch]">
        <p className="x-eyebrow">Overview</p>
        <h1 className="x-display-1 mt-3 text-balance text-ink">One deployment, every surface in view.</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-pretty text-ink-soft">
          What lives here, what each surface does, and where to enter it. Ask the network directly from{" "}
          <Link href="/terminal" className="text-amber underline decoration-amber/40 underline-offset-4 hover:text-amber-soft">
            the terminal
          </Link>
          .
        </p>
      </header>

      <section aria-label="Destinations" className="mt-8 grid gap-3">
        {entries.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="group flex items-start justify-between gap-4 rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-ink">{entry.label}</span>
              <span className="mt-1 block max-w-[58ch] text-[12.5px] leading-relaxed text-ink-soft">{entry.desc}</span>
            </span>
            <ArrowRight size={15} aria-hidden className="mt-1 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-teal" />
          </Link>
        ))}
      </section>

      <section aria-label="Minds in service" className="mt-10">
        <h2 className="x-label">Minds in service</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {available.map((mind) => (
            <li key={mind.slug}>
              <Link
                href={`/minds/${mind.slug}`}
                className="inline-flex min-h-8 items-center rounded-full border border-edge bg-panel px-3 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:border-teal/40 hover:text-teal"
              >
                {mind.name}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          <span className="tabular">{available.length}</span> available
          {planned > 0 ? <> · <span className="tabular">{planned}</span> more defined in the registry</> : null} · every
          Mind plans before it spends and names what the network could not answer.
        </p>
      </section>

      <section aria-label="The network behind the answers" className="mt-10">
        <h2 className="x-label">The network behind the answers</h2>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]">
          {network.map((item) => (
            <li key={item.href} className="list-none">
              <Link href={item.href} className="inline-flex min-h-8 items-center text-ink-soft underline-offset-4 transition-colors hover:text-ink hover:underline">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          Secondary references for this phase: who answers, what settled, and how to integrate.
        </p>
      </section>
    </div>
  );
}
