import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { fetchMiners, type NetworkMiner } from "@/lib/explorer/network";

export const metadata = { title: "Miner" };
export const dynamic = "force-dynamic";

function micro(usdc?: number) {
  return usdc === undefined ? undefined : `$${(usdc / 1_000_000).toFixed(2)}`;
}

function SchemaBlock({ title, schema }: { title: string; schema: unknown }) {
  if (schema === null || schema === undefined || (typeof schema === "object" && Object.keys(schema).length === 0)) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-5">
        <p className="x-label">{title}</p>
        <p className="mt-2.5 text-[12.5px] text-ink-faint">Not published by this miner.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-edge bg-panel p-5">
      <p className="x-label">{title}</p>
      <pre className="tabular mt-3 max-h-80 overflow-auto text-[11px] leading-relaxed text-ink-soft">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </div>
  );
}

export default async function MinerDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const fetched = await fetchMiners();
  if (fetched.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · MINER</p>
        <h1 className="x-display-1 mt-4 text-ink">Registry unavailable</h1>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
          The miner catalog could not be fetched: <span className="tabular text-[12px]">{fetched.detail}</span>
        </p>
      </div>
    );
  }

  const miner: NetworkMiner | undefined = fetched.payload.find((m) => m.slug === slug);
  if (!miner) notFound();

  const price = micro(miner.min_price_usdc);
  const scored = (miner.scores ?? []).slice(0, 8);

  return (
    <article className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <Link href="/miners" className="inline-flex items-center gap-1.5 text-[12px] text-amber hover:text-amber-soft">
        <ArrowLeft size={12} aria-hidden /> All miners
      </Link>

      <header className="mt-6 border-b border-edge pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="x-tag">{miner.protocol} PROTOCOL · {miner.activation_status.toUpperCase()}</p>
            <h1 className="x-display-1 mt-3 text-ink">{miner.name}</h1>
            <p className="tabular mt-2 text-[12px] text-ink-faint">{miner.slug}</p>
          </div>
          {price && (
            <div className="rounded-lg border border-edge bg-panel px-5 py-3 text-right">
              <p className="x-label">Min price</p>
              <p className="tabular mt-1 text-[17px] font-semibold text-teal">{price}</p>
            </div>
          )}
        </div>
        {miner.description && (
          <div className="mt-6 max-w-[72ch] text-[13.5px] leading-relaxed text-ink-soft">
            {miner.description.split("\n").map((p, i) => (
              <p key={i} className={i > 0 ? "mt-2.5" : undefined}>{p}</p>
            ))}
          </div>
        )}
      </header>

      {/* Facts */}
      <section className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Wallet address</p>
          <p className="tabular mt-2 break-all text-[11px] text-ink">{miner.wallet_address}</p>
        </div>
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Service base URL</p>
          <p className="tabular mt-2 break-all text-[11px] text-ink">{miner.base_url}</p>
        </div>
        <div className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">Registered</p>
          <p className="tabular mt-2 text-[12.5px] text-ink">
            {miner.registered_at ? new Date(miner.registered_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"}
          </p>
          {typeof miner.total_requests_served === "number" && (
            <p className="tabular mt-1 text-[11.5px] text-ink-faint">{miner.total_requests_served.toLocaleString()} requests served</p>
          )}
        </div>
      </section>

      {/* Supported intents */}
      <section className="mt-10">
        <p className="x-label">Supported intents</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(miner.supported_intents ?? []).map((i) => (
            <Link
              key={i}
              href={`/intents/${encodeURIComponent(i)}`}
              className="rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-teal hover:text-teal"
            >
              {i.toLowerCase().replaceAll("_", " ")}
            </Link>
          ))}
        </div>
      </section>

      {/* Endpoints */}
      {(miner.endpoints ?? []).length > 0 && (
        <section className="mt-10">
          <p className="x-label">Declared endpoints</p>
          <div className="mt-3 space-y-3">
            {miner.endpoints.map((ep, idx) => (
              <div key={idx} className="rounded-lg border border-edge bg-panel p-4">
                <p className="tabular text-[12.5px] font-medium text-ink">
                  {ep.method ? `${ep.method} ` : "GET "}
                  {ep.path}
                </p>
                {ep.description && <p className="mt-1.5 max-w-[76ch] text-[12px] leading-relaxed text-ink-soft">{ep.description}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Schemas */}
      <section className="mt-10">
        <p className="x-label">Schemas as registered</p>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <SchemaBlock title="Input schema" schema={miner.input_schema} />
          <SchemaBlock title="Output schema" schema={miner.output_schema} />
        </div>
      </section>

      {/* Scores */}
      {scored.length > 0 && (
        <section className="mt-10">
          <p className="x-label">Epoch scores (latest recorded)</p>
          <div className="mt-3 overflow-hidden rounded-lg border border-edge">
            <table className="w-full text-[12.5px]">
              <thead className="bg-panel-3">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left font-medium text-ink-faint">Intent</th>
                  <th scope="col" className="tabular px-4 py-2 text-right font-medium text-ink-faint">Epoch</th>
                  <th scope="col" className="tabular px-4 py-2 text-right font-medium text-ink-faint">Rank</th>
                  <th scope="col" className="tabular px-4 py-2 text-right font-medium text-ink-faint">Score</th>
                </tr>
              </thead>
              <tbody className="bg-panel divide-y divide-edge">
                {scored.map((s, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-2 text-ink">{s.intent_id?.toLowerCase().replaceAll("_", " ") ?? "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-ink-soft">{s.epoch_id ?? "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-ink-soft">{s.rank ?? "—"}</td>
                    <td className="tabular px-4 py-2 text-right text-ink">{s.score !== undefined ? s.score.toFixed(4) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="x-tag mt-2.5">SCORES ARE PUBLISHED BY THE NETWORK'S EVALUATION LAYER, NOT COMPUTED HERE</p>
        </section>
      )}

      {/* Limitations */}
      {(miner.limitations ?? []).some(Boolean) && (
        <section className="mt-10">
          <p className="x-label">Declared limitations</p>
          <ul className="mt-3 space-y-2.5 max-w-[76ch]">
            {(miner.limitations ?? []).filter(Boolean).map((lim, idx) => (
              <li key={idx} className="rounded-lg border border-edge bg-panel p-4 text-[12.5px] leading-relaxed text-ink-soft">
                {lim.message}
                {lim.code && <span className="tabular ml-2 text-[10px] text-ink-faint">{lim.code}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Terminal hook */}
      <section className="mt-12 rounded-lg border border-amber/40 bg-amber-soft/40 p-6">
        <p className="x-tag">OPEN IN THE INTERACTIVE TERMINAL</p>
        <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-soft">
          Ask this miner in the terminal: it pins the request to {miner.name}, shows the x402 price before anything
          is signed, and returns the answer with its receipt. Open it prefilled:{" "}
          <Link href={`/terminal?miner=${encodeURIComponent(miner.slug ?? miner.id)}`} className="text-amber underline decoration-amber/40 underline-offset-4 hover:text-amber-soft">
            /terminal?miner={miner.slug ?? miner.id}
          </Link>
        </p>
      </section>
    </article>
  );
}
