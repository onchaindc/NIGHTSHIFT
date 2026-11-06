import Link from "next/link";

import { getTask } from "@/lib/engine/store";
import { reconcileLedger } from "@/lib/engine/ledger";
import { EvidenceList, StatusChip } from "@/components/taskParts";

export const dynamic = "force-dynamic";

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const INTENT_LABEL: Record<string, string> = {
  information: "Information",
  preparation: "Preparation",
  execution: "Execution",
};

export default async function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id).catch(() => null);

  if (!task) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">CONSOLE · ACTIVITY</p>
        <h1 className="x-display-1 mt-4 text-ink">Activity not found</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          No record with this id exists in the store. That means it has never been run on this deployment&apos;s
          persistence, it was deleted, or the store has been reset; nothing is shown rather than a guessed record.
        </p>
        <Link href="/activity" className="btn-quiet mt-6 !min-h-9">
          Back to activity
        </Link>
      </div>
    );
  }

  const ledger = reconcileLedger(task);
  // Phase 5b: interactive Terminal asks carry their own facts (intent, miner,
  // request body, the user-approved offer). Render those instead of the
  // planner-criteria block, which only an engine run has.
  const terminal = task.jobType === "terminal_request" ? task.terminal ?? null : null;
  const entries = task.spend.entries ?? [];
  const intent = task.criteria.goalIntent ? INTENT_LABEL[task.criteria.goalIntent] ?? task.criteria.goalIntent : null;
  const primarySource = task.criteria.primarySource ?? null;
  const resultEvidence = task.result?.evidence ?? [];
  const receiptsEvidence = resultEvidence.filter((e) => e.kind === "telegraph_receipt");
  const settlementEvidence = resultEvidence.filter((e) => e.kind === "on_chain_settlement");

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Link href="/activity" className="x-label inline-flex items-center gap-2 hover:text-amber">
        ← ACTIVITY
      </Link>

      <p className="x-tag mt-4">ACTIVITY RECORD · {task.jobType === "protocol_watch" ? "WATCH RUN" : task.jobType === "terminal_request" ? "TERMINAL ASK" : "TASK"}</p>
      <h1 className="x-display-1 mt-3 max-w-[70ch] text-ink">{task.goal}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-soft">
        <StatusChip state={task.state} />
        <span>{fmtTime(task.createdAt)}</span>
        {task.origin.source === "telegram" ? <span>via Telegram</span> : null}
        {(task.labels ?? []).length > 0 && (
          <span className="rounded-full border border-edge bg-panel px-2 py-0.5 text-[11px] text-ink-faint">
            {task.labels!.join(" · ")}
          </span>
        )}
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2 lg:gap-4">
        {/* Request */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">{terminal ? "THE TERMINAL ASK" : "THE REQUEST"}</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px]">
            {terminal ? (
              <>
                <Row k="Intent" v={terminal.intent ?? "not stated by the response"} />
                <Row k="Miner" v={terminal.miner ?? "not stated by the response"} />
                {terminal.endpointPath && <Row k="Paid endpoint" v={terminal.endpointPath} mono />}
                {terminal.offer && (
                  <Row
                    k="Approved offer"
                    v={`${Number(terminal.offer.amount) / 10000} USDC to ${terminal.offer.payTo} on ${terminal.offer.network} (${terminal.offer.asset})`}
                  />
                )}
                {terminal.payerAddress && <Row k="Payer (public address)" v={terminal.payerAddress} mono />}
                {typeof terminal.durationMs === "number" && <Row k="Duration" v={`${terminal.durationMs} ms`} />}
                {terminal.timestamp && <Row k="Node timestamp" v={terminal.timestamp} />}
              </>
            ) : (
              <>
                <Row k="Goal intent" v={intent ?? "not classified"} />
                <Row
                  k="Answer source"
                  v={primarySource === "telegraph" ? "Paid Telegraph miner" : primarySource === "free" ? "Free sources and read-only chain access" : "Planner chose automatically"}
                />
                <Row k="Approval required" v={task.permissions.requiresApproval ? "Yes: a plan needs explicit approval before paid steps" : "No"} />
                <Row k="Budget ceiling" v={`${money(task.spend.limitUsdCents)} (spend cap before execution)`} />
              </>
            )}
          </dl>
          {terminal?.request != null && (
            <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-panel-3 p-3 text-[11.5px] leading-relaxed text-ink">
              {typeof terminal.request === "string" ? terminal.request : JSON.stringify(terminal.request, null, 2)}
            </pre>
          )}
        </section>

        {/* Execution outcome */}
        <section className="rounded-lg border border-edge bg-panel p-5">
          <p className="x-label">EXECUTION OUTCOME</p>
          {task.result ? (
            <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{task.result.summary}</p>
          ) : task.error ? (
            <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{task.error}</p>
          ) : task.state === "awaiting_approval" ? (
            <p className="mt-3 text-[13.5px] text-ink-soft">Waiting for explicit approval of the plan; nothing has been paid.</p>
          ) : task.state === "rejected" ? (
            <p className="mt-3 text-[13.5px] text-ink-soft">The plan was rejected; nothing was executed and nothing was paid.</p>
          ) : task.state === "failed" || task.state === "blocked" ? (
            <p className="mt-3 text-[13.5px] text-ink-soft">The task stopped before a verified result existed. Read the record&apos;s execution log for the exact reason.</p>
          ) : (
            <p className="mt-3 text-[13.5px] text-ink-soft">Still in progress: the record updates as the engine works.</p>
          )}
          {settlementEvidence.length > 0 && (
            <div className="mt-3 space-y-0.5 text-[11.5px] text-ink-faint">
              {settlementEvidence.map((e, i) =>
                e.kind === "on_chain_settlement" ? (
                  <p key={i}>
                    Settlement confirmed on chain: <span className="tabular">{e.txHash}</span> status {e.status}, block {e.blockNumber}.
                  </p>
                ) : null,
              )}
            </div>
          )}
        </section>

        {/* Payments */}
        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">PAYMENTS</p>
          {entries.length === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-soft">
              No payments are recorded for this request. Nothing was signed and nothing settled.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="py-2 pr-4 font-medium">Paid</th>
                    <th className="py-2 pr-4 font-medium">Token</th>
                    <th className="py-2 pr-4 font-medium">Network</th>
                    <th className="py-2 pr-4 font-medium">Settlement</th>
                    <th className="py-2 font-medium">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i} className="border-b border-edge/60 last:border-0">
                      <td className="py-2.5 pr-4 tabular text-ink">{money(e.amountUsdCents)}</td>
                      <td className="py-2.5 pr-4 text-ink-soft">USDC</td>
                      <td className="tabular py-2.5 pr-4 text-ink-soft">
                        {terminal?.offer?.network ?? "Base Sepolia (testnet)"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {e.txHash ? (
                          <a
                            href={`https://sepolia.basescan.org/tx/${e.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue hover:underline underline-offset-2"
                          >
                            <span className="tabular">{e.txHash}</span>
                          </a>
                        ) : (
                          <span className="text-ink-faint">not on file</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        {e.signalHash ? (
                          <Link href={`/signals/${e.signalHash}`} className="text-blue tabular hover:underline underline-offset-2">
                            {e.signalHash}
                          </Link>
                        ) : (
                          <span className="text-ink-faint">none</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entries.length > 0 && (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
              {ledger.problems.length === 0
                ? `Ledger reconciliation: all ${ledger.entries} entries carry complete hashes and the sums agree with the accounted spend. Deliveries: ${ledger.deliveredAnswers}, challenges: ${ledger.challengeAttempts}.`
                : `Ledger reconciliation flagged this record: ${ledger.problems.join("; ")}.`}
              {ledger.uncertainPricedAttempts > 0 &&
                ` ${ledger.uncertainPricedAttempts} attempt${ledger.uncertainPricedAttempts === 1 ? "" : "s"} were priced by the network but never delivered an answer; the client cannot see whether those settled, so they stay flagged here rather than being counted as free.`}
            </p>
          )}
        </section>

        {/* Receipt details + evidence */}
        <section className="rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <p className="x-label">RECEIPTS AND EVIDENCE</p>
          {receiptsEvidence.length === 0 && entries.length === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-soft">
              Not available yet: without a delivered paid answer this record holds no Telegraph receipt.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {receiptsEvidence.map((e, i) =>
                e.kind === "telegraph_receipt" ? (
                  <div key={`r${i}`} className="rounded-md border border-edge bg-panel-2 px-3.5 py-2.5 text-[12.5px]">
                    <dl className="grid gap-x-8 gap-y-1.5">
                      <Row k="Receipt hash" v={e.receiptHash} mono />
                      {e.txHash && <Row k="Settlement tx" v={e.txHash} mono />}
                      <Row k="Amount collected" v={money(e.amountUsdCents)} />
                    </dl>
                  </div>
                ) : null,
              )}
              <EvidenceList evidence={resultEvidence} />
              {terminal?.settlementHeader && (
                <div className="rounded-md border border-edge bg-panel-2 px-3.5 py-2.5 text-[12.5px]">
                  <Row k="PAYMENT-RESPONSE (settlement proof, verbatim)" v={terminal.settlementHeader} mono />
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href={`/tasks/${task.id}`} className="btn-quiet !min-h-9">
          Full execution timeline
        </Link>
        <Link href="/activity" className="btn-quiet !min-h-9">
          Back to activity
        </Link>
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-32 shrink-0 text-[11px] uppercase tracking-wide text-ink-faint">{k}</dt>
      <dd className={`text-ink ${mono ? "tabular break-all text-[11.5px]" : ""}`}>{v}</dd>
    </div>
  );
}
