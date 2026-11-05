import Link from "next/link";

export const metadata = { title: "Terminal" };

const STEPS = [
  {
    n: "01",
    title: "Ask in plain language",
    body: "You type a question, exactly as you would say it. The terminal classifies it against the live intent catalog — the same registry this explorer reads — with no intent guessing on your part.",
  },
  {
    n: "02",
    title: "Route to the strongest miner",
    body: "It proposes a specific supporting miner for your intent, ranked by the network's published epoch scores, and shows its declared price before anything runs.",
  },
  {
    n: "03",
    title: "Confirm the x402 contract",
    body: "The exact challenge — amount, asset, network, recipient — is displayed for approval. Nothing is signed or paid until you accept, mirroring the flow the protocol uses for every paid request.",
  },
  {
    n: "04",
    title: "Receive answer with proof",
    body: "The miner's answer comes back with its signal hash and evaluation status, so quality claims stay checkable rather than taken on faith.",
  },
];

export default function TerminalPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <p className="x-tag">EXPLORER · PHASE 2 PLANNED</p>
      <h1 className="x-display-1 mt-3 text-ink">The interactive terminal</h1>
      <p className="mt-4 max-w-[66ch] text-[14.5px] leading-relaxed text-ink-soft">
        Phase 1 of the explorer reads the network; phase 2 talks to it. The planned terminal is a single conversational
        surface over the same registries — every intent and miner listed here will be reachable as an action, with the
        same price transparency and approval gates. The interface below is a design contract, not a demo: it will not
        pretend to answer anything until it is wired to the live network.
      </p>

      <ol className="mt-12 border-t border-edge">
        {STEPS.map((s) => (
          <li key={s.n} className="grid gap-x-6 gap-y-2 border-b border-edge py-7 sm:grid-cols-[72px_1fr] lg:grid-cols-[72px_220px_1fr]">
            <p className="tabular text-[13px] text-ink-faint" aria-hidden>{s.n}</p>
            <h3 className="text-[15.5px] font-semibold leading-snug text-ink sm:pr-6">{s.title}</h3>
            <p className="text-[13.5px] leading-relaxed text-ink-soft">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-12 rounded-lg border border-amber/40 bg-amber-soft/40 p-6">
        <p className="x-tag">STATUS</p>
        <p className="mt-3 max-w-[64ch] text-[13.5px] leading-relaxed text-ink-soft">
          Not built yet in this phase. The explorer&apos;s data layer is already terminal-shaped: an intent&apos;s
          supporting miners, each miner&apos;s price and schemas, and the live x402 challenge are all server-side and
          ready to be invoked from the terminal when its phase lands.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/intents" className="btn-primary !min-h-10">Browse intents</Link>
        <Link href="/miners" className="btn-quiet !min-h-10">Browse miners</Link>
      </div>
    </div>
  );
}
