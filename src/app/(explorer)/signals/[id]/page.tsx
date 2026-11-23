import Link from "next/link";

import { ResultView } from "@/components/result-view";
import { fetchDaemonSignalByHash, fetchSignalRecording, type DaemonSignal } from "@/lib/daemon/client";

export const dynamic = "force-dynamic";

const HASH_RE = /^0x[0-9a-f]{64}$/i;

function fmtUtc(iso?: string): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+/, "").replace("Z", "") + " UTC";
}

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fetched = await fetchSignalRecording(id);

  if (fetched.status !== "ok") {
    const unknown = HASH_RE.test(id);
    if (unknown) {
      const feed = await fetchDaemonSignalByHash(id);
      if (feed.status === "ok" && feed.payload) return <FeedSignal signal={feed.payload} />;
    }
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · SIGNALS</p>
        <h1 className="x-display-1 mt-4 text-ink">{unknown ? "No recording for this signal" : "Not a signal hash"}</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          {unknown
            ? "The engine holds no stored recording under this hash. Refused requests never produced one, and recordings age out of the engine's retention window; the live Signals feed is the best place to open current signals."
            : "Signal details are read by the signal's hash, which is 0x followed by 64 hex characters."}{" "}
          Detail: <span className="tabular text-[12px]">{fetched.detail}</span>
        </p>
        <Link href="/signals" className="btn-quiet mt-6 !min-h-9">
          Back to signals
        </Link>
      </div>
    );
  }

  const rec = fetched.payload;
  const meta = rec.signal ?? {};
  const payload = rec.payload ?? {};
  const daemonRow = rec.result;
  const q = daemonRow?.question;
  const execResult = daemonRow?.execution?.result as
    | { answer?: string; brief?: string; attribution?: string; confidence?: number; as_of?: string }
    | undefined;
  const intentId = meta.intent_id || payload.intent_id || daemonRow?.routing?.intent || null;
  const miner = meta.miner_slug || payload.miner_slug || daemonRow?.routing?.miner_slug || null;
  const answer = execResult?.answer ?? payload.response ?? "";
  const request = payload.request ?? q?.text ?? "";
  const verified = rec.verification?.verified === true;

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Link href="/signals" className="x-label inline-flex items-center gap-2 hover:text-amber">
        ← SIGNALS
      </Link>

      <p className="x-tag mt-4">SIGNAL RECORDING · {rec.kind?.toUpperCase() ?? "SIGNAL"}</p>
      <h1 className="x-display-1 mt-3 text-ink">{request ? request.slice(0, 160) : "Signal " + rec.signal_hash.slice(0, 14) + "…"}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-soft">
        <span className="tabular">{fmtUtc(payload.timestamp ?? meta.created_at)}</span>
        {intentId && (
          <Link
            href={`/intents/${intentId}`}
            className="rounded-full border border-teal bg-teal/5 px-2.5 py-1 text-[11.5px] font-medium text-teal transition-colors hover:bg-teal/10"
          >
            {intentId.toLowerCase().replaceAll("_general", "").replaceAll(/_/g, " ").trim()}
          </Link>
        )}
        {miner && (
          <Link href={`/miners/${miner}`} className="text-teal underline-offset-4 hover:underline">
            Miner: {miner}
          </Link>
        )}
        {meta.subnet_id && (
          <span className="tabular text-[12px] text-ink-faint">Subnet {meta.subnet_id}</span>
        )}
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2 lg:gap-4">
        {/* Question */}
        {q && (q.text || q.category) && (
          <section className="rounded-lg border border-edge bg-panel p-5 sm:col-span-2">
            <p className="x-label">THE DAEMON&apos;S QUESTION</p>
            {q.text && <p className="mt-2 text-[14px] leading-relaxed text-ink">{q.text}</p>}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-faint">
              {q.category && <span>Category: {q.category.toLowerCase()}</span>}
              {typeof q.interest_score === "number" && q.interest_score > 0 && <span className="tabular">Interest {q.interest_score.toFixed(1)}/10</span>}
              {typeof q.affected_pct === "number" && q.affected_pct > 0 && <span className="tabular">Affected {q.affected_pct}%</span>}
              {typeof q.audience_pct === "number" && q.audience_pct > 0 && <span className="tabular">Audience {q.audience_pct}%</span>}
              {daemonRow?.source && <span>Source: {daemonRow.source}</span>}
            </div>
          </section>
        )}

        {/* Request + answer */}
        {request && (
          <section className="rounded-lg border border-edge bg-panel p-5">
            <p className="x-label">ROUTED REQUEST</p>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{request}</pre>
          </section>
        )}
        {answer && (
          <section className="rounded-lg border border-edge bg-panel p-5">
            <p className="x-label">DELIVERED ANSWER</p>
            <div className="mt-3">
              <ResultView result={answer} />
            </div>
            <details className="mt-4 rounded-lg border border-edge bg-panel-2">
              <summary className="cursor-pointer px-3.5 py-2.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink-soft">
                Technical details
              </summary>
              <pre className="max-h-80 overflow-auto border-t border-edge px-3.5 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">{answer}</pre>
            </details>
          </section>
        )}

        {/* Verification */}
        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">VERIFICATION</p>
          {rec.verification && Object.keys(rec.verification).length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <span className={verified ? "font-medium text-teal" : "font-medium text-amber"}>
                {verified ? "Commitment verified by the node" : "Not verified by the node"}
              </span>
              {rec.verification.algorithm && (
                <span className="tabular text-[12px] text-ink-faint">Algorithm {rec.verification.algorithm}</span>
              )}
              {rec.verification.commitment && (
                <span className="tabular text-[12px] text-ink-faint">Commits to {rec.verification.commitment}</span>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-ink-soft">Not available yet.</p>
          )}
          {execResult?.attribution && <p className="mt-2 text-[12px] text-ink-faint">Attribution: {execResult.attribution}</p>}
          <p className="mt-3 text-[12px] text-ink-faint">
            Payment receipts are issued to the paying channel with each response; the Daemon&apos;s stored signals are
            outputs of the network&apos;s own scheduled runs.
          </p>
        </section>

        {/* Metadata */}
        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">METADATA</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
            <Row k="Signal hash" v={rec.signal_hash} mono />
            {meta.result_id && <Row k="Result id" v={meta.result_id} mono />}
            {ipcIntent(meta.intent_id || payload.intent_id) && <Row k="Intent id" v={String(meta.intent_id || payload.intent_id)} />}
            {miner && <Row k="Miner" v={miner} />}
            {meta.subnet_id && <Row k="Subnet id" v={meta.subnet_id} mono />}
            {daemonRow?.status && <Row k="Status" v={daemonRow.status} />}
            <Row k="Recorded" v={fmtUtc(meta.created_at)} />
            {meta.wallet_address ? <Row k="Payer wallet" v={meta.wallet_address} mono /> : null}
          </dl>
        </section>
      </div>
    </div>
  );
}

function FeedSignal({ signal }: { signal: DaemonSignal }) {
  const question = signal.question;
  const intent = signal.routing?.intent ?? null;
  const miner = signal.routing?.miner_slug ?? null;
  const title = question?.text?.trim() || `Signal ${signal.signal_hash.slice(0, 14)}…`;
  const delivered = signal.execution?.result;
  const hasDelivered =
    delivered != null && (typeof delivered !== "object" || Object.keys(delivered as Record<string, unknown>).length > 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Link href="/signals" className="x-label inline-flex items-center gap-2 hover:text-amber">
        ← SIGNALS
      </Link>

      <p className="x-tag mt-4">SIGNAL FEED · {signal.type?.toUpperCase() ?? "SIGNAL"}</p>
      <h1 className="x-display-1 mt-3 max-w-[70ch] text-ink">{title}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-soft">
        <span className="tabular">{fmtUtc(signal.created_at)}</span>
        {intent && (
          <Link
            href={`/intents/${intent}`}
            className="rounded-full border border-teal bg-teal/5 px-2.5 py-1 text-[11.5px] font-medium text-teal transition-colors hover:bg-teal/10"
          >
            {intent.toLowerCase().replaceAll("_general", "").replaceAll(/_/g, " ").trim()}
          </Link>
        )}
        {miner && (
          <Link href={`/miners/${miner}`} className="text-teal underline-offset-4 hover:underline">
            Miner: {miner}
          </Link>
        )}
        <span
          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ${
            signal.status === "success" ? "border-teal/40 text-teal" : "border-amber/40 text-amber"
          }`}
        >
          {signal.status}
        </span>
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2 lg:gap-4">
        <section className="rounded-lg border border-edge bg-panel p-5 sm:col-span-2">
          <p className="x-label">THE DAEMON&apos;S QUESTION</p>
          <p className="mt-2 text-[14px] leading-relaxed text-ink">{title}</p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-faint">
            {question?.category && <span>Category: {question.category.toLowerCase()}</span>}
            {typeof question?.interest_score === "number" && question.interest_score > 0 && (
              <span className="tabular">Interest {question.interest_score.toFixed(1)}/10</span>
            )}
            {signal.source && <span>Source: {signal.source}</span>}
          </div>
        </section>

        {hasDelivered ? (
          <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
            <p className="x-label">FEED ANSWER</p>
            <div className="mt-3">
              <ResultView result={delivered} />
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">WHY THIS IS A FEED RECORD</p>
          <p className="mt-2 max-w-[72ch] text-[13px] leading-relaxed text-ink-soft">
            The engine did not return a stored recording for this hash, but the signal is still in the Daemon&apos;s
            recent feed. The feed row is shown here instead of a dead link; it does not invent an answer that the
            engine no longer has.
          </p>
        </section>

        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">FEED RECORD</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
            <Row k="Signal hash" v={signal.signal_hash} mono />
            {signal.id && <Row k="Feed id" v={signal.id} mono />}
            {signal.routing_mode && <Row k="Routing mode" v={signal.routing_mode} />}
            {question?.category && <Row k="Category" v={question.category} />}
            {signal.routing?.subnet_id && <Row k="Subnet id" v={signal.routing.subnet_id} mono />}
            {intent && <Row k="Intent" v={intent} />}
            {miner && <Row k="Miner" v={miner} />}
            <Row k="Recorded" v={fmtUtc(signal.created_at)} />
          </dl>
        </section>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/signals" className="btn-quiet !min-h-9">
          Back to live signals
        </Link>
      </div>
    </div>
  );
}

function ipcIntent(v?: string): boolean {
  return Boolean(v);
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{k}</dt>
      <dd className={`text-ink ${mono ? "tabular text-[11.5px] break-all" : ""}`}>{v}</dd>
    </div>
  );
}
