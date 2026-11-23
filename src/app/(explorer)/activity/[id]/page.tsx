import Link from "next/link";
import { cookies, headers } from "next/headers";

import { OPERATOR_COOKIE, requestAuthorizedFromParts } from "@/lib/api/auth";
import { ResultView, resultFromSummary } from "@/components/result-view";
import { activityOffer, activityTitle, payerOf } from "@/lib/terminal/activity";
import { getTask } from "@/lib/engine/store";
import { reconcileLedger } from "@/lib/engine/ledger";
import { EvidenceList, StatusChip } from "@/components/taskParts";

export const dynamic = "force-dynamic";

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The explorer for the chain the payment actually settled on. */
const EXPLORERS: Record<string, string> = {
  "eip155:11155111": "https://sepolia.etherscan.io/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:1": "https://etherscan.io/tx/",
};

function txHref(hash: string | undefined, network: string | undefined): string | null {
  if (!hash) return null;
  const base = network ? EXPLORERS[network] : undefined;
  return base ? `${base}${hash}` : null;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtIso(value: string) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? fmtTime(ts) : value;
}

const INTENT_LABEL: Record<string, string> = {
  information: "Information",
  preparation: "Preparation",
  execution: "Execution",
};

const CHAIN_NAMES: Record<string, string> = {
  "eip155:1": "Ethereum",
  "eip155:8453": "Base",
  "eip155:11155111": "Ethereum Sepolia",
  "eip155:84532": "Base Sepolia",
};

function chainName(network?: string): string {
  return network ? CHAIN_NAMES[network] ?? network : "Unknown network";
}

function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function shortHash(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function humanIntent(raw: string): string {
  const spaced = raw.toLowerCase().replaceAll("_", " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function paramLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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

  // Operator clearance: full records (objectives, reports, evidence,
  // settlement proofs, the payment ledger) are operator-only. An anonymous
  // visitor gets the discovery-level projection: that a record exists, its
  // kind, its lifecycle state, when it ran and the aggregate spend.
  const authHeader = (await headers()).get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const operatorCookie = (await cookies()).get(OPERATOR_COOKIE)?.value;
  if (!requestAuthorizedFromParts(bearer, operatorCookie)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">ACTIVITY RECORD · RESTRICTED</p>
        <h1 className="x-display-1 mt-4 text-ink">Restricted activity record</h1>
        <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-soft">
          <StatusChip state={task.state} />
          <span>{fmtTime(task.createdAt)}</span>
          <span>{task.jobType === "protocol_watch" ? "watch run" : task.jobType === "terminal_request" ? "terminal ask" : task.jobType === "mind_investigation" ? "investigation" : "task"}</span>
          <span>
            spent {money(task.spend.spentUsdCents)} of the {money(task.spend.limitUsdCents)} ceiling
          </span>
        </p>
        <p className="mt-4 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-soft">
          Investigation objectives, reports, evidence and settlement proofs are operator-only and are not
          shown here. Sign in from Settings to view this record in full, or call the API with the operator
          bearer token.
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
  const offer = activityOffer(task);
  const payer = payerOf(task);
  const entries = task.spend.entries ?? [];
  const intent = task.criteria.goalIntent ? INTENT_LABEL[task.criteria.goalIntent] ?? task.criteria.goalIntent : null;
  const primarySource = task.criteria.primarySource ?? null;
  const resultEvidence = task.result?.evidence ?? [];
  const receiptsEvidence = resultEvidence.filter((e) => e.kind === "telegraph_receipt");
  const settlementEvidence = resultEvidence.filter((e) => e.kind === "on_chain_settlement");
  const signalEvidence = resultEvidence.find((e) => e.kind === "telegraph_signal");
  const signalHash =
    entries.find((e) => e.signalHash)?.signalHash ??
    (signalEvidence?.kind === "telegraph_signal" ? signalEvidence.signalHash : undefined);
  const txHash = entries.find((e) => e.txHash)?.txHash;
  const transactionHref = txHref(txHash, offer?.network);

  // Guided asks store the exact body the user approved. Show its question
  // parameters as fields; keep the JSON itself behind a disclosure.
  const terminalRequest =
    terminal?.request && typeof terminal.request === "object"
      ? (terminal.request as Record<string, unknown>)
      : null;
  const requestParams =
    terminalRequest?.params && typeof terminalRequest.params === "object"
      ? (terminalRequest.params as Record<string, unknown>)
      : null;
  const paramFields: Array<{ key: string; label: string; value: string }> = requestParams
    ? Object.entries(requestParams)
        .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
        .map(([key, value]) => ({ key, label: paramLabel(key), value: String(value) }))
    : [];
  const requestQuery = typeof terminalRequest?.query === "string" ? terminalRequest.query.trim() : "";
  if (paramFields.length === 0 && requestQuery) {
    paramFields.push({ key: "query", label: "Question", value: requestQuery });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Link href="/activity" className="x-label inline-flex items-center gap-2 hover:text-amber">
        ← ACTIVITY
      </Link>

      <p className="x-tag mt-4">ACTIVITY RECORD · {task.jobType === "protocol_watch" ? "WATCH RUN" : task.jobType === "terminal_request" ? "TERMINAL ASK" : "TASK"}</p>
      <h1 className="x-display-1 mt-3 max-w-[70ch] text-ink">{activityTitle(task)}</h1>
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
          <p className="x-label">{terminal ? "YOUR ASK" : "THE REQUEST"}</p>
          {terminal ? (
            <>
              <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px]">
                {terminal.intent && <Row k="Type" v={humanIntent(terminal.intent)} />}
                {terminal.miner && <Row k="Answered by" v={terminal.miner} />}
                {offer && <Row k="Price" v={`${(Number(offer.amount) / 1_000_000).toFixed(2)} USDC`} />}
                {offer && <Row k="Network" v={chainName(offer.network)} />}
                {offer && <Row k="Paid to" v={shortAddress(offer.payTo)} title={offer.payTo} mono />}
                {payer && <Row k="Paid from" v={shortAddress(payer)} title={payer} mono />}
                {typeof terminal.durationMs === "number" && <Row k="Answered in" v={`${terminal.durationMs} ms`} />}
                {terminal.timestamp && <Row k="Recorded" v={fmtIso(terminal.timestamp)} />}
              </dl>
              {paramFields.length > 0 && (
                <div className="mt-3">
                  <p className="x-label">QUESTION DETAILS</p>
                  <dl className="mt-2 grid gap-2 rounded-lg border border-edge bg-panel-2 px-3.5 py-3 text-[13px]">
                    {paramFields.map((field) => (
                      <Row key={field.key} k={field.label} v={field.value} />
                    ))}
                  </dl>
                </div>
              )}
              {terminal.request != null && (
                <details className="mt-3 rounded-lg border border-edge bg-panel-2">
                  <summary className="cursor-pointer px-3.5 py-2.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink-soft">
                    Full request payload
                  </summary>
                  <pre className="max-h-72 overflow-auto border-t border-edge px-3.5 py-3 text-[11px] leading-relaxed text-ink-soft">
                    {typeof terminal.request === "string" ? terminal.request : JSON.stringify(terminal.request, null, 2)}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <dl className="mt-3 grid gap-x-8 gap-y-2 text-[13px]">
              <Row k="Goal intent" v={intent ?? "not classified"} />
              <Row
                k="Answer source"
                v={primarySource === "telegraph" ? "Paid Telegraph miner" : primarySource === "free" ? "Free sources and read-only chain access" : "Planner chose automatically"}
              />
              <Row k="Approval required" v={task.permissions.requiresApproval ? "Yes: a plan needs explicit approval before paid steps" : "No"} />
              <Row k="Budget ceiling" v={`${money(task.spend.limitUsdCents)} (spend cap before execution)`} />
            </dl>
          )}
        </section>

        {/* Execution outcome */}
        <section className="order-first rounded-lg border border-edge bg-panel p-5 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="x-label">{task.result ? "THE ANSWER" : "EXECUTION OUTCOME"}</p>
              {task.result && (
                <p className="mt-1 text-[12px] text-ink-faint">
                  {terminal?.miner ? `Returned by ${terminal.miner}` : "Returned by the network"}
                  {typeof task.result.completedAt === "number" ? ` · ${fmtTime(task.result.completedAt)}` : ""}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {signalHash && (
                <Link
                  href={`/signals/${signalHash}`}
                  className="rounded-full border border-teal/40 bg-teal/5 px-3 py-1.5 text-[11.5px] font-medium text-teal transition-colors hover:bg-teal/10"
                >
                  View signal →
                </Link>
              )}
              {transactionHref && (
                <a
                  href={transactionHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-edge bg-panel-2 px-3 py-1.5 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-edge-strong hover:text-ink"
                >
                  View transaction ↗
                </a>
              )}
            </div>
          </div>
          {task.result ? (
            <div className="mt-3">
              <ResultView result={resultFromSummary(task.result.summary)} />
              <details className="mt-4 rounded-lg border border-edge bg-panel-2">
                <summary className="cursor-pointer px-3.5 py-2.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink-soft">
                  Technical details
                  <span className="ml-2 text-ink-faint">
                    raw payload · {task.result.summary.length.toLocaleString()} characters
                  </span>
                </summary>
                <pre className="max-h-80 overflow-auto border-t border-edge px-3.5 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">{task.result.summary}</pre>
              </details>
            </div>
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
                    Settlement confirmed on chain: <span className="tabular" title={e.txHash}>{shortHash(e.txHash)}</span> status {e.status}, block {e.blockNumber}.
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
                      <td className="py-2.5 pr-4 text-ink-soft">
                        {offer ? chainName(offer.network) : "—"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {txHref(e.txHash, offer?.network) ? (
                          <a
                            href={txHref(e.txHash, offer?.network) as string}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={e.txHash}
                            className="text-blue hover:underline underline-offset-2"
                          >
                            <span className="tabular">{shortHash(e.txHash as string)}</span>
                          </a>
                        ) : e.txHash ? (
                          <span className="tabular" title={e.txHash}>{shortHash(e.txHash)}</span>
                        ) : (
                          <span className="text-ink-faint">not on file</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        {e.signalHash ? (
                          <Link
                            href={`/signals/${e.signalHash}`}
                            title={e.signalHash}
                            className="text-blue hover:underline underline-offset-2"
                          >
                            View signal →
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

function Row({ k, v, mono, title }: { k: string; v: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-32 shrink-0 text-[11px] uppercase tracking-wide text-ink-faint">{k}</dt>
      <dd className={`text-ink ${mono ? "tabular break-all text-[11.5px]" : ""}`} title={title}>{v}</dd>
    </div>
  );
}
