import Link from "next/link";
import { ArrowRight, ShieldCheck, ReceiptText } from "lucide-react";

import {
  fetchIntents,
  fetchLiveOffer,
  fetchMiners,
  fetchValidators,
  type LiveChallengeOffer,
} from "@/lib/explorer/network";
import { NetworkBadge } from "@/components/explorer/network-badge";

export const metadata = {
  title: "Intelligence",
  description:
    "The intelligence network live: miners, intents, evaluators, validators — and the applications built on top, from settlement assurance to the activity ledger.",
};
export const dynamic = "force-dynamic";

function microcents(usdc?: number) {
  return usdc === undefined ? null : `$${(usdc / 1_000_000).toFixed(2)}`;
}

function Stat({
  label,
  value,
  href,
  suffix,
}: {
  label: string;
  value: string | number | null;
  href: string;
  suffix?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-1 flex-col gap-1.5 rounded-2xl border border-edge bg-panel px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_12px_30px_-22px_rgba(22,24,29,0.4)]"
    >
      <span className="tabular text-[26px] font-semibold leading-none tracking-tight text-ink">
        {value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value}
        {suffix && <span className="ml-1.5 text-[12px] font-normal text-ink-faint">{suffix}</span>}
      </span>
      <span className="flex items-center justify-between gap-2 text-[12px] text-ink-soft">
        {label}
        <ArrowRight
          size={13}
          aria-hidden
          className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-amber"
        />
      </span>
    </Link>
  );
}

const ROLES = [
  {
    href: "/miners",
    title: "Miners",
    body: "Independent services that answer questions, each publishing its endpoints and price.",
  },
  {
    href: "/intents",
    title: "Intents",
    body: "The shared registry of question types miners compete to answer.",
  },
  {
    href: "/evaluators",
    title: "Evaluators",
    body: "They score every round, so ranking reflects quality rather than volume.",
  },
  {
    href: "/validators",
    title: "Validators",
    body: "They confirm settlement and finalize results — the integrity layer.",
  },
];

const APPLICATIONS = [
  {
    href: "/assurance",
    icon: ShieldCheck,
    eyebrow: "Application",
    title: "Settlement assurance",
    body: "Verify a high-value Solana transfer before it settles: counterparty identity, sanctions, filings, documents and the CLEARED / HOLD / ESCALATE decision with cited evidence.",
    cta: "Open assurance",
    accent: true,
  },
  {
    href: "/activity",
    icon: ReceiptText,
    eyebrow: "Ledger",
    title: "Activity",
    body: "Every run, ask and payment on this deployment — what ran, when, and what it cost. Nothing hidden.",
    cta: "Open the ledger",
    accent: false,
  },
];

export default async function IntelligencePage() {
  const [miners, validators, intents, offer] = await Promise.all([
    fetchMiners(),
    fetchValidators(),
    fetchIntents(),
    fetchLiveOffer(),
  ]);

  const liveOffer: LiveChallengeOffer | null = offer.status === "ok" ? offer.payload : null;
  const price = liveOffer ? microcents(Number(liveOffer.amount)) : null;
  const canonicalIntents = intents.status === "ok" ? intents.payload.filter((i) => i.canonical).length : null;
  const allOk = miners.status === "ok" && validators.status === "ok" && intents.status === "ok";

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-[58ch]">
          <p className="x-eyebrow">The intelligence network</p>
          <h1 className="x-display-1 mt-3 text-balance text-ink">
            Specialists on call, prices in the open.
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-pretty text-ink-soft">
            Telegraph pays independent miners per answer. Every price is published before you commit, every answer is
            scored, and every settlement is confirmed by validators. This is the live view — and the applications
            running on top.
          </p>
        </div>
        <NetworkBadge live={allOk} />
      </header>

      {/* Live pulse — every number is read from the node, never invented */}
      <section aria-label="Live network numbers" className="mt-8 flex flex-wrap gap-3 sm:flex-nowrap">
        <Stat label="Miners live" value={miners.status === "ok" ? miners.payload.length : null} href="/miners" />
        <Stat label="Question types" value={canonicalIntents} href="/intents" />
        <Stat
          label="Validators signing"
          value={validators.status === "ok" ? validators.payload.length : null}
          href="/validators"
        />
        <Stat label="Per ask, right now" value={price} href="/terminal" />
      </section>

      {/* Applications — the founder framing: assurance is one application of the network */}
      <section aria-label="Applications" className="mt-10">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          {APPLICATIONS.map((app) => {
            const Icon = app.icon;
            return (
              <Link
                key={app.href}
                href={app.href}
                className={`group relative overflow-hidden rounded-3xl border p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-30px_rgba(22,24,29,0.5)] sm:p-7 ${
                  app.accent
                    ? "border-teal/30 bg-gradient-to-br from-teal/[0.06] to-panel"
                    : "border-edge bg-panel"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={`grid h-9 w-9 place-items-center rounded-lg border ${
                      app.accent ? "border-teal/40 bg-teal/10 text-teal" : "border-edge bg-panel-2 text-ink-soft"
                    }`}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                  </span>
                  <p className="x-eyebrow !mt-0">{app.eyebrow}</p>
                </div>
                <h2 className="mt-4 text-[17px] font-semibold tracking-tight text-ink">{app.title}</h2>
                <p className="mt-2 max-w-[56ch] text-[13.5px] leading-relaxed text-ink-soft">{app.body}</p>
                <p className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-teal">
                  {app.cta}
                  <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
                </p>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Roles — one compact strip */}
      <section aria-label="Roles" className="mt-10">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="x-label">Four roles, one contract</h2>
          <Link href="/developers" className="text-[12px] text-ink-faint transition-colors hover:text-ink">
            Build on it →
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="group rounded-2xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[14px] font-semibold text-ink transition-colors group-hover:text-teal">{r.title}</h3>
                <ArrowRight
                  size={14}
                  aria-hidden
                  className="shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-amber"
                />
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{r.body}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* The ask contract — one honest line, not a wall of numbers */}
      <section aria-label="The ask contract" className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-edge bg-panel px-5 py-4">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">
              Discover → price → approve → answer.
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
              {liveOffer
                ? `The node is challenging asks at ${price} per answer on ${liveOffer.assetName ?? "USDC"} (${liveOffer.network}). You sign the exact amount, nothing more.`
                : "No live challenge is being published right now — prices appear here the moment the node quotes one."}
            </p>
          </div>
          <Link href="/terminal" className="btn-quiet !min-h-9 shrink-0">
            Try an ask
            <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      </section>
    </div>
  );
}
