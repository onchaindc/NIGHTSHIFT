import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchIntents, fetchLiveOffer, fetchMiners, fetchValidators, type LiveChallengeOffer } from "@/lib/explorer/network";
import { NetworkBadge } from "@/components/explorer/network-badge";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

function microcents(usdc?: number) {
  return usdc === undefined ? null : `$${(usdc / 1_000_000).toFixed(2)}`;
}

/**
 * The ask lifecycle, as an animated schematic rather than a paragraph: four
 * steps, the live price pinned to the card. The packet travelling the rail is
 * decorative (CSS only); every number on the card is read, never invented.
 */
function AskLifecycle({ offer }: { offer: LiveChallengeOffer | null }) {
  const price = offer ? microcents(Number(offer.amount)) : null;
  const steps = [
    { n: "01", label: "Discover", detail: "free · miner catalog" },
    { n: "02", label: "Probe", detail: "402 · priced offer" },
    { n: "03", label: "Pay", detail: "x402 · signed transfer" },
    { n: "04", label: "Answer", detail: "200 · receipt + signal" },
  ];

  return (
    <figure className="x-sheen relative overflow-hidden rounded-2xl border border-edge bg-panel p-5 shadow-[0_18px_40px_-32px_rgba(22,24,29,0.45)] sm:p-6">
      <figcaption className="flex items-center justify-between gap-3">
        <p className="x-label">One ask, end to end</p>
        <p className="x-tag inline-flex items-center gap-1.5">
          <span aria-hidden className="x-live-dot h-1.5 w-1.5 rounded-full bg-teal" />
          LIVE
        </p>
      </figcaption>

      <ol className="relative mt-5 space-y-3.5 pl-7">
        {/* rail + travelling packet */}
        <span aria-hidden className="absolute bottom-1.5 left-[5px] top-1.5 w-px bg-edge" />
        <span aria-hidden className="x-packet absolute left-[2px] h-1.5 w-1.5 rounded-full bg-amber shadow-[0_0_0_3px_rgba(180,83,9,0.14)]" />
        {steps.map((s) => (
          <li key={s.n} className="relative">
            <span aria-hidden className="absolute -left-[26px] top-[7px] h-1.5 w-1.5 rounded-full border border-edge-strong bg-panel" />
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="tabular text-[10.5px] text-ink-faint">{s.n}</span>
              <span className="text-[13.5px] font-semibold text-ink">{s.label}</span>
              <span className="tabular ml-auto text-[10.5px] text-ink-faint">{s.detail}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex items-end justify-between gap-3 border-t border-edge pt-4">
        <div>
          <p className="x-label">Price right now</p>
          <p className="tabular mt-1 text-[22px] font-semibold leading-none text-ink">
            {price ?? "—"}
            <span className="ml-1.5 text-[11px] font-normal text-ink-faint">per ask</span>
          </p>
        </div>
        <p className="tabular max-w-[45%] break-all text-right text-[10px] leading-relaxed text-ink-faint">
          {offer ? offer.network : "no live challenge"}
        </p>
      </div>
    </figure>
  );
}

function ChallengeContract({ offer }: { offer: LiveChallengeOffer | null }) {
  if (!offer) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-6">
        <p className="x-tag">LIVE PAYMENT CONTRACT</p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          Not available right now. The node returned no payment challenge for the test ask. Retry in a moment.
        </p>
      </div>
    );
  }
  const price = microcents(Number(offer.amount));
  return (
    <div className="rounded-xl border border-edge bg-panel p-5 sm:p-6">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div>
          <dt className="x-label">Price per ask</dt>
          <dd className="tabular mt-1 text-[15px] font-medium text-ink">{price ?? offer.amount}</dd>
        </div>
        <div>
          <dt className="x-label">Asset on chain</dt>
          <dd className="mt-1 text-[14px] font-medium text-ink">
            {offer.assetName ?? "Unknown token"}
            <span className="tabular ml-2 break-all text-[11px] text-ink-faint">{offer.asset}</span>
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
            <span className="tabular ml-2 break-all text-[11px] text-ink-faint">{offer.payTo}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-5 text-[12px] leading-relaxed text-ink-faint">
        Read from the node&apos;s current challenge. This is exactly what a caller signs before a miner runs.
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
    { label: "Miners answering", value: miners.status === "ok" ? miners.payload.length : null, href: "/miners" },
    { label: "Kinds of question", value: intents.status === "ok" ? intents.payload.filter((i) => i.canonical).length : null, href: "/intents" },
    { label: "Validators signing", value: validators.status === "ok" ? validators.payload.length : null, href: "/validators" },
    {
      label: "Validator tokens mined",
      value:
        validators.status === "ok"
          ? validators.payload.reduce((n, v) => n + Number(v.tokensMined ?? "0"), 0)
          : null,
      href: "/validators",
    },
  ];

  /* One line each: the four roles are a map, not an essay. */
  const roles = [
    {
      href: "/miners",
      title: "Miners",
      body: "Independent services that answer intents, each declaring its endpoints and price.",
    },
    {
      href: "/evaluators",
      title: "Evaluators",
      body: "Score answers per intent each epoch, so ranking reflects quality.",
    },
    {
      href: "/validators",
      title: "Validators",
      body: "Countersign settlement and finalize signals; the integrity layer.",
    },
    {
      href: "/intents",
      title: "Intents",
      body: "The shared vocabulary of question types miners compete to answer.",
    },
  ];

  const liveOffer = offer.status === "ok" ? offer.payload : null;

  return (
    <div>
      {/* Hero: one statement, one sentence, the life of a request. */}
      <section className="relative overflow-hidden border-b border-edge">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(900px 320px at 88% -8%, rgba(180,83,9,0.10), transparent 70%), radial-gradient(700px 300px at 0% 0%, rgba(15,118,110,0.07), transparent 70%)",
          }}
        />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-14 lg:py-20">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <p className="x-tag">NIGHTSHIFT · TELEGRAPH NETWORK</p>
              <NetworkBadge live={miners.status === "ok" && validators.status === "ok" && intents.status === "ok"} />
            </div>
            <h1 className="x-display-hero mt-5 max-w-[24ch] text-balance text-ink">
              A network that <span className="italic text-amber-deep">answers on demand</span>.
            </h1>
            <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-pretty text-ink-soft">
              Miners answer questions for a micropayment. NIGHTSHIFT shows who is answering, what they cover, and what
              one ask costs right now — read live from the public registries, never mocked.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link href="/miners" className="btn-primary !min-h-11">
                Browse miners
                <ArrowRight size={14} aria-hidden />
              </Link>
              <Link href="/terminal" className="btn-quiet !min-h-11">
                Try one ask
              </Link>
            </div>
            <p className="x-tag mt-6">
              NO ACCOUNT · NO API KEY · THE x402 PAYMENT IS THE AUTHENTICATION
            </p>
          </div>

          <AskLifecycle offer={liveOffer} />
        </div>
      </section>

      {/* Numbers: labelled cards, each a door into its section. */}
      {counts.some((c) => c.value !== null) && (
        <section className="border-b border-edge bg-panel/40">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="x-tag">ON THE NETWORK RIGHT NOW</p>
              <p className="x-tag">READ FROM devnode.telegraphprotocol.com</p>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {counts.map((c) => (
                <Link
                  key={c.label}
                  href={c.href}
                  className="group rounded-xl border border-edge bg-panel p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_6px_18px_-12px_rgba(22,24,29,0.35)]"
                >
                  <p className="tabular text-[32px] font-semibold leading-none text-ink">
                    {c.value !== null ? c.value.toLocaleString() : "—"}
                  </p>
                  <p className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-soft">
                    {c.label}
                    <ArrowRight
                      size={13}
                      aria-hidden
                      className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-amber"
                    />
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Roles: the map, four lines. */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="x-tag">THE PARTICIPANTS</p>
              <h2 className="x-display-1 mt-3 max-w-2xl text-ink">Four roles, one contract</h2>
            </div>
            <Link href="/developers" className="btn-quiet !min-h-9">
              How to integrate
              <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
          <div className="mt-7 grid gap-3 sm:grid-cols-2 sm:gap-4">
            {roles.map((r) => (
              <Link
                key={r.title}
                href={r.href}
                className="group rounded-xl border border-edge bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_6px_18px_-10px_rgba(22,24,29,0.35)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[15px] font-semibold text-ink transition-colors group-hover:text-teal">{r.title}</h3>
                  <ArrowRight size={14} aria-hidden className="shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-amber" />
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{r.body}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Live price contract. */}
      <section className="border-b border-edge bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="x-tag">LIVE MARKET</p>
              <h2 className="x-display-1 mt-3 max-w-2xl text-ink">What one ask costs right now</h2>
            </div>
            <p className="max-w-[34ch] text-[12.5px] leading-relaxed text-ink-faint">
              The node&apos;s own challenge for a test ask — price, asset, chain and recipient.
            </p>
          </div>
          <div className="mt-7">
            <ChallengeContract offer={liveOffer} />
          </div>
        </div>
      </section>

      {/* Terminal: one action, no paragraph. */}
      <section className="border-b border-edge">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="min-w-0">
              <p className="x-tag">ASK IT YOURSELF</p>
              <h2 className="x-display-2 mt-3 max-w-[34ch] text-balance text-ink">Compose an ask. See the price. Approve it.</h2>
              <p className="tabular mt-3 text-[12px] text-ink-faint">
                probe <span className="text-amber">→</span> 402 price <span className="text-amber">→</span> approve{" "}
                <span className="text-amber">→</span> answer + receipt
                <span aria-hidden className="x-caret ml-1 inline-block h-3 w-1.5 translate-y-0.5 bg-amber" />
              </p>
            </div>
            <Link href="/terminal" className="btn-primary !min-h-11">
              Open the Terminal
              <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
