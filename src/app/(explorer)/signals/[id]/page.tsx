import Link from "next/link";

import { fetchSignalRecording } from "@/lib/daemon/client";

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
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · SIGNALS</p>
        <h1 className="x-display-1 mt-4 text-ink">{unknown ? "No recording for this signal" : "Not a signal hash"}</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          {unknown
            ? "The engine holds no stored signal under this hash. Refused requests never produced one, and signals can take a cycle to publish."
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

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
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
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{answer}</pre>
            <div className="mt-2 text-[11.5px] text-ink-faint">
              Shown as stored by the node; long outputs are truncated by your browser&apos;s scroll.
            </div>
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
