import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchIntents, fetchLiveOffer, fetchMiners, fetchValidators, type LiveChallengeOffer } from "@/lib/explorer/network";
import { NetworkBadge } from "@/components/explorer/network-badge";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

function microcents(usdc?: number) {
  return usdc === undefined ? null : `$${(usdc / 1_000_000).toFixed(2)}`;
}

function ChallengeContract({ offer }: { offer: LiveChallengeOffer | null }) {
  if (!offer) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-6">
        <p className="x-tag">LIVE PAYMENT CONTRACT</p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          Not available this moment: the node did not return a payment challenge for a test ask, so no contract is shown
          rather than a stale or invented one. Retry in a moment.
        </p>
      </div>
    );
  }
  const price = microcents(Number(offer.amount));
  return (
    <div className="rounded-lg border border-edge bg-panel p-6">
      <p className="x-tag">LIVE PAYMENT CONTRACT · x402 EXACT</p>
      <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="x-label">Price per ask</dt>
          <dd className="tabular mt-1 text-[15px] font-medium text-ink">{price ?? offer.amount}</dd>
        </div>
        <div>
          <dt className="x-label">Asset on chain</dt>
          <dd className="mt-1 text-[14px] font-medium text-ink">
            {offer.assetName ?? "Unknown token"}
            <span className="tabular ml-2 text-[11px] text-ink-faint">{offer.asset}</span>
          </dd>
        </div>
        <div>
          <dt className="x-label">Network</dt>
          <dd className="tabular mt-1 text-[14px] text-ink">{offer.network}</dd>
        </div>
        <div>
          <dt className="x-label">Scheme · recipient</dt>
          <dd className="mt-1 text-[14px] font-medium text-ink">
            <span className="tabular">{offer.scheme}</span>
            <span className="tabular ml-2 text-[11px] text-ink-faint">{offer.payTo}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-5 max-w-[64ch] text-[12.5px] leading-relaxed text-ink-faint">
        Read from a real, unpaid ask the node challenged right now — this is exactly what a caller is asked to sign
        before any miner runs. Nothing in the explorer ever spends on its own.
      </p>
    </div>
  );
}

export default async function OverviewPage() {
  const [miners, validators, intents, offer] = await Promise.all([
    fetchMiners(),
    fetchValidators(),
    fetchIntents(),
    fetchLiveOffer(),
  ]);

  const counts = [
    { label: "Registered miners", value: miners.status === "ok" ? miners.payload.length : null, href: "/miners" },
    { label: "Canonical intents", value: intents.status === "ok" ? intents.payload.filter((i) => i.canonical).length : null, href: "/intents" },
    { label: "Registered validators", value: validators.status === "ok" ? validators.payload.length : null, href: "/validators" },
    {
      label: "Mined tokens (validators)",
      value:
        validators.status === "ok"
          ? validators.payload.reduce((n, v) => n + Number(v.tokensMined ?? "0"), 0)
          : null,
      href: "/validators",
    },
  ];

  const roles = [
    {
      href: "/miners",
      title: "Miners",
      body: "Independent services that answer intents — a specific kind of question with a defined input and output. Each miner declares its endpoints, schemas, supported intents and price up front, and earns per answered request.",
    },
    {
      href: "/evaluators",
      title: "Evaluators",
      body: "The quality layer of the network. Evaluators compare how different miners answered the same intent and score each epoch, so ranking reflects real answer quality rather than declarations. There is no public registration endpoint yet: the explorer reports that honestly instead of inventing a list.",
    },
    {
      href: "/validators",
      title: "Validators",
      body: "The settlement and integrity layer. A validator publishes its address and peer identity, tracks tokens mined and relay activity, and countersigns the lifecycle of paid requests on the challenge network.",
    },
    {
      href: "/intents",
      title: "Intents",
      body: "The shared vocabulary of the network: a cataloged intent names a kind of question. Each carries a canonical registration (on chain), a plain-language description, and a count of miners that currently serve it.",
    },
  ];

  return (
    <div>
      {/* Hero */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="x-tag">TELEGRAPH PROTOCOL · OPEN NETWORK</p>
            <NetworkBadge live={miners.status === "ok" && validators.status === "ok" && intents.status === "ok"} />
          </div>
          <h1 className="x-display-hero mt-6 max-w-[26ch] text-ink">
            A network that <span className="italic text-amber-soft">answers on demand</span>.
          </h1>
          <p className="mt-6 max-w-[62ch] text-[15px] leading-relaxed text-ink-soft">
            Telegraph is an open, intent-based intelligence network. Miners register to answer specific kinds of
            questions — intents — for a per-request price settled with x402. Quality is scored epoch by epoch so
            results align to what actually works, not to what merely claims to. This explorer reads the public
            registries and shows you who is on the network, what they do, and what an ask honestly costs today.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/miners" className="btn-primary !min-h-11">
              Browse miners
              <ArrowRight size={14} aria-hidden />
            </Link>
            <Link href="/intents" className="btn-quiet !min-h-11">
              Explore intents
            </Link>
          </div>
        </div>
      </section>

      {/* Live band */}
      {counts.some((c) => c.value !== null) && (
        <section className="border-b border-edge bg-panel/40">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4 sm:divide-x sm:divide-edge">
              {counts.map((c) => (
                <Link key={c.label} href={c.href} className="group">
                  <p className="tabular text-[30px] font-semibold leading-none text-ink">
                    {c.value !== null ? c.value.toLocaleString() : "—"}
                  </p>
                  <p className="x-label mt-2 transition-colors group-hover:text-amber">{c.label}</p>
                </Link>
              ))}
            </div>
            <p className="x-tag mt-8">READ FROM THE PUBLIC REGISTRIES AT devnode.telegraphprotocol.com · REFRESHED ROUTINELY</p>
          </div>
        </section>
      )}

      {/* Roles */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <p className="x-tag">THE PARTICIPANTS</p>
          <h2 className="x-display-1 mt-4 max-w-2xl text-ink">Four roles, one contract</h2>
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            {roles.map((r) => (
              <Link
                key={r.title}
                href={r.href}
                className="group rounded-lg border border-edge bg-panel p-6 transition-colors hover:border-edge-strong"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[15.5px] font-semibold text-ink">{r.title}</h3>
                  <ArrowRight size={14} aria-hidden className="text-ink-faint transition-colors group-hover:text-amber" />
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">{r.body}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Live challenge */}
      <section className="border-b border-edge bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <p className="x-tag">NS/01 · WHAT AN ASK COSTS · RIGHT NOW</p>
          <h2 className="x-display-1 mt-4 max-w-2xl text-ink">One challenge, at market</h2>
          <div className="mt-8">
            <ChallengeContract offer={offer.status === "ok" ? offer.payload : null} />
          </div>
        </div>
      </section>

      {/* Terminal teaser */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="x-tag">NS/02 · THE INTERACTIVE TERMINAL</p>
              <h2 className="x-display-2 mt-4 max-w-[36ch] text-ink">Beyond reading: an action layer is coming.</h2>
              <p className="mt-3 max-w-[64ch] text-[13.5px] leading-relaxed text-ink-soft">
                Phase 2 of this explorer replaces the static views with a conversational terminal directly over the same
                registries: ask an intent a real question, route it to the highest-ranked supporting miner, and see the
                exact x402 contract before anything is signed. The explorer you are reading keeps that same shape —
                every intent here lists the command it will map to.
              </p>
            </div>
            <Link href="/terminal" className="btn-quiet !min-h-11">
              See what is planned
              <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
