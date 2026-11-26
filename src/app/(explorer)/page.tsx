import Link from "next/link";
import { ArrowRight, BrainCircuit, ShieldCheck } from "lucide-react";

import { fetchIntents, fetchLiveOffer, fetchMiners, fetchValidators } from "@/lib/explorer/network";
import { NetworkBadge } from "@/components/explorer/network-badge";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

function microcents(usdc?: number) {
  return usdc === undefined ? null : `$${(usdc / 1_000_000).toFixed(2)}`;
}

/**
 * The front page. One screen, one job: what this is, what is live right now,
 * and the two doors that matter — Minds (ask) and Assurance (verify). Every
 * number is read live from the node; nothing is estimated or invented.
 */
export default async function OverviewPage() {
  const [miners, validators, intents, offer] = await Promise.all([
    fetchMiners(),
    fetchValidators(),
    fetchIntents(),
    fetchLiveOffer(),
  ]);

  const liveOffer = offer.status === "ok" ? offer.payload : null;
  const price = liveOffer ? microcents(Number(liveOffer.amount)) : null;
  const allOk = miners.status === "ok" && validators.status === "ok" && intents.status === "ok";

  const pulse = [
    { label: "Miners live", value: miners.status === "ok" ? miners.payload.length : null, href: "/miners" },
    {
      label: "Question types",
      value: intents.status === "ok" ? intents.payload.filter((i) => i.canonical).length : null,
      href: "/intents",
    },
    {
      label: "Validators",
      value: validators.status === "ok" ? validators.payload.length : null,
      href: "/validators",
    },
    { label: "Per ask now", value: price, href: "/terminal" },
  ];

  const doors = [
    {
      href: "/minds",
      icon: BrainCircuit,
      eyebrow: "Ask",
      title: "Minds",
      body: "Autonomous specialist investigators — counterparties, indices, mining, trade, ownership — with pinned providers, published prices and a full evidence trail.",
      cta: "Choose a Mind",
      accent: false,
    },
    {
      href: "/desk",
      icon: ShieldCheck,
      eyebrow: "Verify",
      title: "Deal Desk",
      body: "Institutional transaction intelligence: open a file on a high-value payment and check the counterparty, their standing and the rails before funds move — one decision, every finding cited.",
      cta: "Open the Deal Desk",
      accent: true,
    },
  ];

  return (
    <div>
      {/* Hero + live pulse: one section instead of four */}
      <section className="relative overflow-hidden border-b border-edge">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(900px 340px at 88% -10%, rgba(180,83,9,0.09), transparent 70%), radial-gradient(720px 320px at 0% 0%, rgba(15,118,110,0.07), transparent 70%)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20 lg:py-24">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center rounded-full border border-edge bg-panel px-3 py-1 text-[11.5px] font-medium text-ink-soft">
              Telegraph network
            </span>
            <NetworkBadge live={allOk} />
          </div>
          <h1 className="x-display-hero mt-6 max-w-[22ch] text-balance text-ink">
            Verified intelligence, <span className="italic text-amber-deep">priced in the open.</span>
          </h1>
          <p className="mt-5 max-w-[56ch] text-[16px] leading-relaxed text-pretty text-ink-soft">
            NIGHTSHIFT runs specialist Minds over the Telegraph network: you see the price before you commit, the
            answer arrives with a receipt, and high-value settlement can be checked before funds move.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/minds" className="btn-primary !min-h-11 !px-5">
              Ask a Mind
              <ArrowRight size={14} aria-hidden />
            </Link>
            <Link href="/miners" className="btn-quiet !min-h-11 !px-5">
              Explore the network
            </Link>
          </div>

          {/* Live pulse strip */}
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {pulse.map((p) => (
              <li key={p.label}>
                <Link
                  href={p.href}
                  className="group block rounded-2xl border border-edge bg-panel/70 px-4 py-3.5 backdrop-blur transition-colors hover:border-edge-strong"
                >
                  <p className="tabular whitespace-nowrap text-[clamp(1.3rem,6vw,1.5rem)] font-semibold leading-none tracking-tight text-ink">
                    {p.value === null ? "—" : typeof p.value === "number" ? p.value.toLocaleString() : p.value}
                  </p>
                  <p className="mt-1.5 text-[12px] text-ink-soft">{p.label}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Two doors: the products this deployment actually serves */}
      <section className="x-reveal border-b border-edge bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="grid gap-4 lg:grid-cols-2">
            {doors.map((d) => {
              const Icon = d.icon;
              return (
                <Link
                  key={d.href}
                  href={d.href}
                  className={`group relative overflow-hidden rounded-3xl border p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-30px_rgba(22,24,29,0.5)] sm:p-8 ${
                    d.accent ? "border-teal/30 bg-gradient-to-br from-teal/[0.06] to-panel" : "border-edge bg-panel"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className={`grid h-9 w-9 place-items-center rounded-lg border ${
                        d.accent ? "border-teal/40 bg-teal/10 text-teal" : "border-edge bg-panel-2 text-ink-soft"
                      }`}
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <p className="x-eyebrow !mt-0">{d.eyebrow}</p>
                  </div>
                  <h2 className="mt-4 text-[19px] font-semibold tracking-tight text-ink">{d.title}</h2>
                  <p className="mt-2.5 max-w-[52ch] text-[13.5px] leading-relaxed text-ink-soft">{d.body}</p>
                  <p className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-teal">
                    {d.cta}
                    <ArrowRight size={14} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* The contract: one honest strip instead of a long market section */}
      <section className="x-reveal border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-edge bg-panel px-5 py-5 sm:px-7">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[14px] font-semibold text-ink">Discover → price → approve → answer.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">
                {liveOffer
                  ? `The node is quoting ${price} per ask on ${liveOffer.assetName ?? "USDC"} (${liveOffer.network}). You approve the exact amount before anything is signed, and the answer arrives with a receipt.`
                  : "No live challenge is being published right now. Open the Terminal to see the price the moment the node quotes one — no account, no API key, pay per ask."}
              </p>
            </div>
            <Link href="/terminal" className="btn-primary !min-h-10 shrink-0 !px-4">
              Open the Terminal
              <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
