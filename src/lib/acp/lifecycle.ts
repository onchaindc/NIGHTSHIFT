/**
 * The ACP seller lifecycle — how a NIGHTSHIFT offering actually runs on an
 * ACP job, wired onto the EXISTING Deal Desk engine:
 *
 *   job.created + requirement  →  validate against the offering's schema
 *                               (invalid: message the buyer, never price —
 *                               the buyer can fund nothing)
 *   priced (setBudget)         →  the v2 acceptance act; the job's list price
 *                               becomes the investigation's spend ceiling
 *   job.funded                 →  create ONE desk investigation (idempotent on
 *                               the job key) + free pre-flight run (no spend)
 *                               + the paid run created and PARKED at the human
 *                               approval gate — this module has no way to
 *                               approve it
 *   tick                       →  follow the investigation through its runs;
 *                               when the report exists, submit the structured,
 *                               evidence-backed deliverable
 *   job.completed              →  settlement observed; only now is the job
 *                               recorded as completed (never before delivery)
 */

import { parseCreateDeskBody, deskSubjectLine } from "@/lib/desk/create";
import { saveDeskInvestigation, getDeskInvestigation } from "@/lib/desk/store";
import { createDeskRun, syncDeskInvestigation, reportDeskInvestigation } from "@/lib/desk/orchestrate";
import { getTask } from "@/lib/engine/store";
import type { DeskInvestigation } from "@/lib/desk/types";
import type { TaskRecord } from "@/lib/engine/types";
import { DESK_TYPE_LABEL } from "@/lib/desk/types";

import { ACP_OFFERINGS, offeringById, validateRequirement } from "./offerings";
import { acpJobKey, getAcpJob, saveAcpJob } from "./store";
import type { AcpJobRecord, AcpEntry, AcpServiceOffering, AcpSessionRef, AcpTransport } from "./types";

/** The deliverable envelope a buyer receives — the whole evidence-backed report. */
export interface DeskDeliverable {
  kind: "nightshift.desk.report.v1";
  offering: string;
  investigationId: string;
  reference: string;
  type: string;
  typeLabel: string;
  subjectLine: string;
  reportSummary: {
    headline: string;
    verdict: string;
    confidence: string;
    counts: Record<string, number>;
  };
  /** Receipts per verified/failed record — the provenance the buyer can check. */
  receipts: Array<{ capability: string; label: string; verification: string; signalHash: string | null; receiptHash: string | null; costUsdCents: number | null }>;
  verificationFailures: Array<{ capability: string; detail: string }>;
  discrepancies: Array<{ title: string; detail: string; material: boolean | null }>;
  missingEvidence: string[];
  unsupportedRequirements: Array<{ label: string; reason: string }>;
  spend: { spentUsdCents: number; entries: number };
  /** The full structured DeskReport, carried verbatim — the buyer receives
   *  the whole evidence ledger, not a summary of it. */
  report: DeskInvestigation["report"];
  /** Where the full report lives (operator/owner-gated). */
  reportEndpoint: string;
}

function newJob(ref: AcpSessionRef, clientAddress: string | null): AcpJobRecord {
  const now = new Date().toISOString();
  return {
    key: acpJobKey(ref),
    chainId: ref.chainId,
    jobId: ref.jobId,
    offering: "(unidentified)",
    clientAddress,
    requirement: null,
    rawRequirement: null,
    status: "received",
    statusDetail: "job.created observed; waiting for the requirement",
    priceUsdCents: null,
    executionCostUsdCents: 0,
    settlementUsdCents: null,
    settlementSettled: false,
    investigationId: null,
    taskIds: [],
    deliverable: null,
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    fundedAt: null,
    deliveredAt: null,
    completedAt: null,
  };
}

async function updateJob(job: AcpJobRecord, status: AcpJobRecord["status"], detail: string): Promise<void> {
  job.status = status;
  job.statusDetail = detail;
  await saveAcpJob(job);
}

/**
 * One ACP entry, processed against the job record. Idempotent per key: a
 * redelivered event lands on the same record and never creates a second
 * investigation or a second price.
 */
export async function handleAcpEntry(
  transport: AcpTransport,
  ref: AcpSessionRef,
  entry: AcpEntry,
): Promise<AcpJobRecord> {
  const key = acpJobKey(ref);
  const job = (await getAcpJob(key)) ?? newJob(ref, entry.clientAddress ?? null);
  if (entry.clientAddress && !job.clientAddress) job.clientAddress = entry.clientAddress;

  if (entry.kind === "system" && entry.event) {
    switch (entry.event.type) {
      case "job.created":
        // First sight: keep the record; the requirement follows — either as a
        // job-room message (registered agent wallets) or, failing that, from
        // the job's own on-chain description (any wallet can transact).
        if (job.status === "received") {
          await updateJob(job, "received", "job.created observed; waiting for the requirement");
          await maybeIntakeFromDescription(transport, ref, job);
        }
        break;
      case "budget.set":
        break; // our own act, echoed
      case "job.funded":
        if (job.status === "accepted") {
          job.fundedAt = new Date().toISOString();
          await startInvestigation(transport, job);
        }
        break;
      case "job.submitted":
        if (job.status === "delivered") await updateJob(job, "delivered", "deliverable submitted on-chain; awaiting the evaluator");
        break;
      case "job.completed":
        if (job.deliverable) {
          job.settlementUsdCents = job.priceUsdCents;
          job.settlementSettled = true;
          job.completedAt = new Date().toISOString();
          await updateJob(job, "completed", "evaluator approved — ACP escrow settled");
        }
        break;
      case "job.rejected":
        if (job.deliverable) await updateJob(job, "rejected", "evaluator rejected the deliverable");
        break;
      case "job.expired":
        if (!job.settlementSettled) await updateJob(job, "expired", "the job expired before settlement");
        break;
    }
    return job;
  }

  // A message: the first requirement on an unpriced job is the intake.
  if (entry.kind === "message" && entry.content && !job.priceUsdCents && (job.status === "received" || job.status === "validated")) {
    return intake(transport, ref, job, entry.content);
  }
  return job;
}

/**
 * The requirement may ride the job's own on-chain description — the only
 * channel that works for a buyer wallet the ACP server has not registered
 * as an agent (their chat API authenticates agents only; the on-chain job
 * path is open to every wallet). Preferred path stays the job-room message;
 * this runs only while the job is still unpriced and un-raw'd.
 */
async function maybeIntakeFromDescription(transport: AcpTransport, ref: AcpSessionRef, job: AcpJobRecord): Promise<void> {
  if (job.rawRequirement || job.priceUsdCents) return;
  if (!transport.jobDescription) return;
  let description: string | null = null;
  try {
    description = await transport.jobDescription(ref);
  } catch {
    return; // no description reachable — wait for the message path
  }
  if (!description) return;
  try {
    const parsed = JSON.parse(description) as Record<string, unknown>;
    if (parsed && typeof parsed.offering === "string") {
      await intake(transport, ref, job, description);
    }
  } catch {
    /* the description is not a requirement payload — nothing to do */
  }
}

/** Intake: parse and validate the requirement; price (accept) or refuse. */
async function intake(transport: AcpTransport, ref: AcpSessionRef, job: AcpJobRecord, raw: string): Promise<AcpJobRecord> {
  job.rawRequirement = raw.slice(0, 4000);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await transport.sendMessage(ref, "The requirement must be a JSON object: {\"offering\": \"nightshift/<service>\", ...inputs}. Nothing was priced and no funds are committed.");
    await updateJob(job, "rejected_intake", "requirement was not valid JSON; buyer messaged; nothing priced");
    return job;
  }

  const offeredId = typeof parsed.offering === "string" ? parsed.offering : "";
  const offering: AcpServiceOffering | undefined = offeredId ? offeringById(offeredId) : undefined;
  if (!offering) {
    const catalogue = ACP_OFFERINGS.map((o) => `${o.id} (${(o.priceUsdCents / 100).toFixed(2)} USD)`).join("; ");
    await transport.sendMessage(ref, `Unknown or missing offering. Published offerings: ${catalogue}. Nothing was priced.`);
    await updateJob(job, "rejected_intake", `unknown offering "${offeredId || "(missing)"}"; buyer messaged; nothing priced`);
    return job;
  }
  job.offering = offering.id;

  const validation = validateRequirement(offering, (parsed.inputs as Record<string, unknown>) ?? parsed);
  if (!validation.ok) {
    await transport.sendMessage(ref, `Requirement rejected — ${validation.error}. Inputs required: ${offering.inputs.filter((i) => i.required).map((i) => i.name).join(", ")}. Nothing was priced.`);
    await updateJob(job, "rejected_intake", `invalid requirement (${validation.error}); buyer messaged; nothing priced`);
    return job;
  }
  job.requirement = validation.subject;
  await updateJob(job, "validated", `requirement validated against ${offering.id}`);

  // The acceptance act: price the job. The buyer funds only against this.
  job.priceUsdCents = offering.priceUsdCents;
  await transport.setBudget(ref, offering.priceUsdCents);
  job.acceptedAt = new Date().toISOString();
  await updateJob(job, "accepted", `priced ${(offering.priceUsdCents / 100).toFixed(2)} USD via setBudget; awaiting the buyer's funding`);
  return job;
}

/**
 * Funding received: create the investigation (once) and start the real
 * engine — free pre-flight immediately (no spend), paid run created and
 * parked at the human approval gate. THIS MODULE CANNOT APPROVE IT.
 */
async function startInvestigation(transport: AcpTransport, job: AcpJobRecord): Promise<void> {
  const offering = offeringById(job.offering);
  if (!offering || !job.requirement) {
    await updateJob(job, "failed", "funded but the offering/requirement vanished — buyer messaged");
    return;
  }
  if (job.investigationId) {
    await updateJob(job, "funded", "funding re-delivered; investigation already exists (idempotent)");
    return;
  }

  const parsed = parseCreateDeskBody(
    {
      type: offering.investigationType,
      subject: job.requirement,
      // The job's own price is the investigation's spend ceiling: the paid
      // run can never exceed what the buyer committed to the escrow.
      spendLimitUsdCents: offering.priceUsdCents,
    },
    "acp-buyer",
    null,
  );
  if (!parsed.ok) {
    await transport.sendMessage(ref2(job), `Investigation could not be opened: ${parsed.error}. Contact the operator.`);
    await updateJob(job, "failed", `investigation create failed: ${parsed.error.slice(0, 140)}`);
    return;
  }
  const inv = parsed.investigation;
  await saveDeskInvestigation(inv);
  job.investigationId = inv.id;
  await updateJob(job, "funded", `investigation ${inv.reference} opened for ${DESK_TYPE_LABEL[inv.type]}`);

  try {
    // 1 — the free pre-flight: schema and routing only, zero spend. Created
    // with autoRun disabled and executed explicitly, so both runs exist and
    // no background writer races the paid task's creation on the file store.
    const free = await createDeskRun(inv, "free", { actor: "acp", owner: null, autoRun: false });
    // 2 — the paid run: CREATED and PARKED at the approval gate
    // (requiresApproval), where the existing human controls own it.
    const paid = await createDeskRun(inv, "intel", { actor: "acp", owner: null, spendLimitUsdCents: offering.priceUsdCents, autoRun: false });
    job.taskIds.push(free.task.id, paid.task.id);
    await updateJob(job, "awaiting_approval", `paid run ${paid.task.id} parked at the human approval gate; free pre-flight ${free.task.id} starting`);
    // Now execute the free pre-flight (awaited: the next tick sees a finished
    // baseline, and no concurrent writer can interleave).
    const { runTask } = await import("@/lib/engine/engine");
    await runTask(free.task.id);
    await updateJob(job, "awaiting_approval", `free pre-flight ${free.task.id} complete at $0.00; paid run ${paid.task.id} parked at the human approval gate`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await transport.sendMessage(ref2(job), `The investigation opened (${inv.reference}) but no run could be planned: ${detail.slice(0, 200)}`);
    await updateJob(job, "failed", `run planning failed: ${detail.slice(0, 200)}`);
  }
}

function ref2(job: AcpJobRecord): AcpSessionRef {
  return { chainId: job.chainId, jobId: job.jobId };
}

/* ------------------------------------------------------------------ */
/* The tick: follow investigations, deliver when the report exists      */
/* ------------------------------------------------------------------ */

export function buildDeliverable(inv: DeskInvestigation, tasks: TaskRecord[]): DeskDeliverable {
  const report = inv.report;
  const spent = tasks.reduce((n, t) => n + t.spend.spentUsdCents, 0);
  const entries = tasks.reduce((n, t) => n + t.spend.entries.length, 0);
  return {
    kind: "nightshift.desk.report.v1",
    offering: `nightshift/${inv.type.replace(/_/g, "-")}`,
    investigationId: inv.id,
    reference: inv.reference,
    type: inv.type,
    typeLabel: DESK_TYPE_LABEL[inv.type],
    subjectLine: deskSubjectLine(inv),
    reportSummary: report
      ? {
          headline: report.headline,
          verdict: report.assessment.verdict,
          confidence: report.confidence,
          counts: report.counts as unknown as Record<string, number>,
        }
      : { headline: "no report stored", verdict: "unknown", confidence: "unknown", counts: {} },
    receipts: inv.evidence
      .filter((e) => e.signalHash && (e.provenance === "verified" || e.provenance === "verification_failed" || e.class === "node_asserted"))
      .map((e) => ({
        capability: e.capability,
        label: e.label,
        verification: e.provenance === "verified" ? "independently re-derived" : e.provenance === "verification_failed" ? "FAILED independent re-derivation" : "node-asserted only",
        signalHash: e.signalHash ?? null,
        receiptHash: e.receiptHash ?? null,
        costUsdCents: e.costUsdCents ?? null,
      })),
    verificationFailures: inv.evidence
      .filter((e) => e.provenance === "verification_failed")
      .map((e) => ({ capability: e.capability, detail: e.detail.slice(0, 500) })),
    discrepancies: (report?.discrepancies ?? []).map((d) => ({ title: d.title, detail: d.detail, material: d.kind === "provider_disagreement" ? d.material === true : null })),
    missingEvidence: inv.evidence.filter((e) => e.provenance === "missing" && e.class === "missing").map((e) => e.title),
    unsupportedRequirements: inv.unsupported.map((g) => ({ label: g.label, reason: g.reason })),
    spend: { spentUsdCents: spent, entries },
    report: inv.report,
    reportEndpoint: `/api/desk/${inv.id}`,
  };
}

/**
 * Advance every open job: follow the investigation's runs and, when the
 * report exists, submit the deliverable through the transport. Never
 * approves anything, never spends anything.
 */
export async function tickAcpJobs(transport: AcpTransport): Promise<{ advanced: number; submitted: string[]; notes: string[] }> {
  const { listAcpJobs } = await import("./store");
  const jobs = await listAcpJobs();
  const submitted: string[] = [];
  const notes: string[] = [];
  let advanced = 0;

  for (const job of jobs) {
    if (!job.investigationId || job.settlementSettled || job.status === "delivered" || job.status === "rejected" || job.status === "expired" || job.status === "failed" || job.status === "rejected_intake") {
      continue;
    }
    const inv = await getDeskInvestigation(job.investigationId);
    if (!inv) {
      await updateJob(job, "failed", "the linked investigation is no longer in the store");
      continue;
    }
    advanced += 1;

    const tasks: TaskRecord[] = [];
    for (const run of inv.runs) {
      const t = await getTask(run.taskId);
      if (t) {
        tasks.push(t);
        run.taskState = t.state;
      }
    }
    job.executionCostUsdCents = tasks.reduce((n, t) => n + t.spend.spentUsdCents, 0);

    const paidTask = tasks.find((t) => t.id === inv.runs.find((r) => r.mode === "intel")?.taskId);
    const paidState = paidTask?.state ?? "unknown";

    if (inv.status === "reported" && inv.report) {
      const deliverable = buildDeliverable(inv, tasks);
      await transport.submit(ref2(job), JSON.stringify(deliverable));
      job.deliverable = JSON.stringify(deliverable);
      job.deliveredAt = new Date().toISOString();
      await updateJob(job, "delivered", `deliverable submitted for ${inv.reference}; awaiting the evaluator`);
      submitted.push(job.key);
      continue;
    }

    if (paidState === "awaiting_approval") {
      await updateJob(job, "awaiting_approval", `paid run parked at the human approval gate (ceiling ${(job.priceUsdCents ?? 0) / 100} USD) — a NIGHTSHIFT operator must release it`);
      continue;
    }
    if (paidState === "executing" || paidState === "verifying") {
      await updateJob(job, "executing", "approved by a human through the existing gate; the engine is running");
      continue;
    }
    if (paidState === "completed") {
      // The task finished but no report yet — build it now (sync + report),
      // then the next tick delivers.
      try {
        await reportDeskInvestigation(inv, "intel");
        notes.push(`${inv.reference}: report built after completion`);
      } catch (err) {
        notes.push(`${inv.reference}: report build failed (${err instanceof Error ? err.message : String(err).slice(0, 120)})`);
      }
      continue;
    }
    if (paidState === "failed" || paidState === "blocked") {
      await transport.sendMessage(ref2(job), `The investigation ${inv.reference} could not complete (engine state: ${paidState}). The job will not be submitted; funds handling follows the ACP protocol.`);
      await updateJob(job, "failed", `underlying run ended ${paidState}`);
      continue;
    }
    await saveAcpJob(job);
  }
  return { advanced, submitted, notes };
}

/** Absorb any new evidence from completed runs without touching spend (a read-side sync). */
export async function refreshInvestigation(inv: DeskInvestigation): Promise<void> {
  await syncDeskInvestigation(inv);
}
