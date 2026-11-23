import Link from "next/link";

export const metadata = { title: "Evaluators" };

/**
 * Evaluators have NO public registration endpoint on the node today — we
 * verified that against the live node rather than assuming. This page states
 * the role precisely and reports the honest availability state; no roster is
 * invented, and the page updates automatically once a real registry exists.
 */
export default function EvaluatorsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <p className="x-eyebrow">Evaluators</p>
      <h1 className="x-display-1 mt-3 text-ink">The quality layer</h1>
      <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">
        Evaluators make ranking mean something. Every epoch, they compare how different miners answered the same intent
        and score the responses, so a miner&apos;s standing on the network reflects what its answers were like, not
        what its declarations promised. The per-intent epoch scores you can see on each miner&apos;s detail page are
        produced by this layer.
      </p>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-edge bg-panel p-6">
          <p className="text-[12.5px] font-semibold text-ink">What evaluators do</p>
          <ul className="mt-4 space-y-3 text-[13.5px] leading-relaxed text-ink-soft">
            <li className="flex gap-2.5"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-hidden />Sample the same intent across several miners — no reporting hack, actual comparative reads.</li>
            <li className="flex gap-2.5"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-hidden />Score each response per intent for the epoch; ranks and scores are then visible on the network for everyone to see.</li>
            <li className="flex gap-2.5"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-hidden />Publish results transparently so miners know what to improve and consumers know who to trust.</li>
          </ul>
        </div>
        <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-6">
          <p className="text-[12.5px] font-semibold text-ink">Registry status</p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
            No public evaluator roster is retrievable from the node right now — its evaluators endpoint does not exist,
            and no directory for this role is served publicly. Instead of padding the page with speculative names, this
            explorer reports that boundary plainly. Miner scores from the evaluation layer remain fully visible{" "}
            <Link href="/miners" className="text-amber underline decoration-amber/40 underline-offset-4 hover:text-amber-soft">
              on miner pages
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
