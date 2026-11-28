import Link from "next/link";
import { ArrowRight, CircleDollarSign, KeyRound, MousePointerClick } from "lucide-react";

import {
  fetchIntents,
  fetchLiveOffer,
  fetchMiners,
  fetchValidators,
  type LiveChallengeOffer,
} from "@/lib/explorer/network";
import { NetworkBadge } from "@/components/explorer/network-badge";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

function microcents(usdc?: number) {
  return usdc === undefined ? null : `$${(usdc / 1_000_000).toFixed(2)}`;
}

/**
 * The ask lifecycle as a small schematic. The packet is decorative CSS; every
 * number on the card is read from the node, never invented.
 */
function AskLifecycle({ offer }: { offer: LiveChallengeOffer | null }) {
  const price = offer ? microcents(Number(offer.amount)) : null;
  const steps = [
    { n: "1", label: "Discover", detail: "Free. Browse the specialist catalog." },
    { n: "2", label: "Probe", detail: "The node returns a priced offer." },
    { n: "3", label: "Approve", detail: "You sign the exact amount." },
    { n: "4", label: "Answer", detail: "You get the answer and a receipt." },
  ];

  return (
    <figure className="x-sheen relative overflow-hidden rounded-3xl border border-edge bg-panel p-6 shadow-[0_24px_60px_-40px_rgba(22,24,29,0.4)] sm:p-7">
      <figcaption className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-ink">How an ask works</p>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/25 bg-teal/5 px-2.5 py-1 text-[11px] font-medium text-teal">
          <span aria-hidden className="x-live-dot h-1.5 w-1.5 rounded-full bg-teal" />
          Live
        </span>
      </figcaption>

      <ol className="relative mt-6 space-y-5 pl-8">
        <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-px bg-edge" />
        <span aria-hidden className="x-packet absolute left-[4px] h-1.5 w-1.5 rounded-full bg-amber shadow-[0_0_0_3px_rgba(180,83,9,0.14)]" />
        {steps.map((s) => (
          <li key={s.n} className="relative">
            <span
              aria-hidden
              className="tabular absolute -left-[30px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-edge-strong bg-panel text-[9px] text-ink-faint"
            >
              {s.n}
            </span>
            <p className="text-[14px] font-semibold text-ink">{s.label}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{s.detail}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex items-end justify-between gap-3 border-t border-edge pt-5">
        <div>
          <p className="text-[12px] text-ink-faint">Price right now</p>
          <p className="tabular mt-1 text-[26px] font-semibold leading-none text-ink">
            {price ?? "Unavailable"}
            {price && <span className="ml-1.5 text-[12px] font-normal text-ink-faint">per ask</span>}
          </p>
        </div>
        <p className="tabular max-w-[42%] break-all text-right text-[10.5px] leading-relaxed text-ink-faint">
          {offer ? offer.network : "No live challenge"}
        </p>
      </div>
    </figure>
  );
}

function ChallengeContract({ offer }: { offer: LiveChallengeOffer | null }) {
  if (!offer) {
    return (
      <div className="rounded-2xl border border-edge bg-panel p-6 sm:p-7">
        <p className="text-[15px] font-semibold text-ink">The node is not publishing a challenge right now</p>
        <p className="mt-2 max-w-[54ch] text-[13.5px] leading-relaxed text-ink-soft">
          A price appears here as soon as the test ask receives a payment challenge. Reload in a moment.
        </p>
      </div>
    );
  }
  const price = microcents(Number(offer.amount));
  return (
    <div className="rounded-2xl border border-edge bg-panel p-6 sm:p-7">
      <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        <div>
          <dt className="text-[12px] text-ink-faint">Price per ask</dt>
          <dd className="tabular mt-1.5 text-[17px] font-semibold text-ink">{price ?? offer.amount}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-ink-faint">Asset on chain</dt>
          <dd className="mt-1.5 text-[15px] font-medium text-ink">
            {offer.assetName ?? "Unknown token"}
            <span className="tabular ml-2 break-all text-[11px] font-normal text-ink-faint">{offer.asset}</span>
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-ink-faint">Network</dt>
          <dd className="tabular mt-1.5 text-[15px] text-ink">{offer.network}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-ink-faint">Paid to</dt>
          <dd className="mt-1.5 text-[15px] font-medium text-ink">
            <span className="tabular break-all">{offer.payTo}</span>
            <span className="ml-2 text-[12px] font-normal text-ink-faint">{offer.scheme}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-6 border-t border-edge pt-5 text-[13px] leading-relaxed text-ink-soft">
        This is the exact challenge a caller signs before a miner runs. It is read live, not estimated.
      </p>
    </div>
  );
}

/** Consistent section header: eyebrow, title, one plain sentence. */
function SectionHead({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="max-w-2xl">
      <p className="x-eyebrow">{eyebrow}</p>
      <h2 className="x-display-1 mt-3 text-balance text-ink">{title}</h2>
      {body && <p className="mt-3 text-[14.5px] leading-relaxed text-pretty text-ink-soft">{body}</p>}
    </div>
  );
}

/**
 * The front page. One screen, one story: what NIGHTSHIFT is, the ask lifecycle
 * running as a live schematic, the numbers on the network right now, and the
 * exact payment challenge the node is publishing. It is a landing page, not a
 * site map — the only doors are the two product actions; every catalog and
 * tool has its place in the nav. Every number is read live from the node;
 * nothing is estimated or invented.
 */
export default async function OverviewPage() {
  const [miners, validators, intents, offer] = await Promise.all([
    fetchMiners(),
    fetchValidators(),
    fetchIntents(),
    fetchLiveOffer(),
  ]);

  const counts = [
    {
      label: "Miners answering",
      value: miners.status === "ok" ? miners.payload.length : null,
    },
    {
      label: "Kinds of question",
      value: intents.status === "ok" ? intents.payload.filter((i) => i.canonical).length : null,
    },
    {
      label: "Validators signing",
      value: validators.status === "ok" ? validators.payload.length : null,
    },
    {
      label: "Validator tokens mined",
      value:
        validators.status === "ok"
          ? validators.payload.reduce((n, v) => n + Number(v.tokensMined ?? "0"), 0)
          : null,
    },
  ];

  const journey = [
    { n: "1", label: "Discover", detail: "Browse specialists and question types for free." },
    { n: "2", label: "Price", detail: "The node quotes a hard amount in USDC." },
    { n: "3", label: "Approve", detail: "You sign exactly that amount — nothing more." },
    { n: "4", label: "Answer", detail: "The answer arrives with a receipt and evidence." },
  ];

  const liveOffer = offer.status === "ok" ? offer.payload : null;
  const allOk = miners.status === "ok" && validators.status === "ok" && intents.status === "ok";

  return (
    <div>
      {/* Hero: story on the left, the running lifecycle on the right */}
      <section className="relative overflow-hidden border-b border-edge">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(900px 340px at 88% -10%, rgba(180,83,9,0.09), transparent 70%), radial-gradient(720px 320px at 0% 0%, rgba(15,118,110,0.07), transparent 70%)",
          }}
        />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16 lg:py-24">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center rounded-full border border-edge bg-panel px-3 py-1 text-[11.5px] font-medium text-ink-soft">
                NIGHTSHIFT / Agent commerce network
              </span>
              <NetworkBadge live={allOk} />
            </div>
            <h1 className="x-display-hero mt-6 max-w-[24ch] text-balance text-ink">
              Agents need each other. <span className="italic text-amber-deep">NIGHTSHIFT makes that business possible.</span>
            </h1>
            <p className="mt-6 max-w-[52ch] text-[16px] leading-relaxed text-pretty text-ink-soft">
              Discover specialist agents, source capabilities, publish requirements and coordinate services across an
              interconnected agent economy.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/overview" className="btn-primary !min-h-11 !px-5">
                Open the network
                <ArrowRight size={14} aria-hidden />
              </Link>
            </div>

            <ul className="mt-9 flex flex-wrap gap-x-7 gap-y-3">
              {[
                { icon: MousePointerClick, label: "No account needed" },
                { icon: KeyRound, label: "No API key" },
                { icon: CircleDollarSign, label: "You pay per ask" },
              ].map(({ icon: Icon, label }) => (
                <li key={label} className="inline-flex items-center gap-2 text-[13px] text-ink-soft">
                  <Icon size={14} aria-hidden className="text-teal" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <AskLifecycle offer={liveOffer} />
        </div>
      </section>

      {/* Live numbers: informational tiles, not a site map */}
      {counts.some((c) => c.value !== null) && (
        <section className="x-reveal border-b border-edge bg-panel/40">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="x-display-2 text-ink">On the network right now</h2>
              <p className="inline-flex items-center gap-2 text-[12.5px] text-ink-faint">
                <span aria-hidden className="x-live-dot h-1.5 w-1.5 rounded-full bg-teal" />
                Read live from the node
              </p>
            </div>
            <div className="mt-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {counts.map((c) => (
                <div
                  key={c.label}
                  className="rise-in rise-in-item rounded-2xl border border-edge bg-panel p-5"
                >
                  <p className="tabular text-[34px] font-semibold leading-none tracking-tight text-ink">
                    {c.value !== null ? c.value.toLocaleString() : "—"}
                  </p>
                  <p className="mt-3 text-[13px] text-ink-soft">{c.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* The journey, as one quiet strip — not link cards */}
      <section className="x-reveal border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <SectionHead
            eyebrow="How a question travels"
            title="Discover, price, approve, answer"
            body="Four fixed stages between a question and a paid, checkable answer. Miners compete to answer, evaluators score the results, validators settle — the roles behind every ask live in the Network section."
          />
          <ol className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {journey.map((s) => (
              <li
                key={s.n}
                className="rise-in rise-in-item relative rounded-2xl border border-edge bg-panel p-5"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="tabular grid h-6 w-6 shrink-0 place-items-center rounded-full border border-edge-strong bg-panel-2 text-[11px] text-ink-soft"
                  >
                    {s.n}
                  </span>
                  <p className="text-[14px] font-semibold text-ink">{s.label}</p>
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">{s.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Live market: the exact challenge, read from the node */}
      <section className="x-reveal border-b border-edge bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <SectionHead
            eyebrow="Live market"
            title="What one ask costs today"
            body="Read from the node's current payment challenge. This is exactly what a caller signs before a miner runs, with nothing added or rounded."
          />
          <div className="mt-8">
            <ChallengeContract offer={liveOffer} />
          </div>
        </div>
      </section>

      {/* Closing door: one action, one surface */}
      <section className="x-reveal border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="x-sheen relative flex flex-wrap items-center justify-between gap-8 overflow-hidden rounded-3xl border border-edge bg-panel p-7 sm:p-10">
            <div className="min-w-0 max-w-xl">
              <p className="x-eyebrow">Try it yourself</p>
              <h2 className="x-display-2 mt-3 text-balance text-ink">Write a question, see the price, approve it.</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
                The Terminal walks you through one ask from start to finish. You approve the exact amount before
                anything is signed, and the answer arrives with a receipt.
              </p>
            </div>
            <Link href="/terminal" className="btn-primary !min-h-11 !px-5">
              Open the Terminal
              <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
