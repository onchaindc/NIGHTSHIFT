/**
 * Deal Desk demonstration walkthrough.
 *
 * Assembles the reproducible, ordered narrative of how a specialised
 * investigation actually ran — inputs, budget approval, the paid Telegraph
 * requests, the provider responses with their receipts, the independent
 * verification outcomes (including failures), the discrepancies and missing
 * evidence, and the final assessment — from the stored investigation and its
 * run tasks. Nothing is fabricated here: every number, hash and sentence is
 * read back from the recorded ledger, so a walkthrough of NS-LU-A803A739 is
 * that file's own history, reproducible by anyone who can read the file.
 */

import type { TaskRecord } from "@/lib/engine/types";
import type { DeskEvidence, DeskInvestigation } from "@/lib/desk/types";
import { DESK_TYPE_LABEL, DESK_VERDICT_LABEL } from "@/lib/desk/types";

export interface WalkthroughRequest {
  capability: string;
  label: string;
  provider: string | null;
  intent: string | null;
  priceUsdCents: number | null;
  signalHash: string | null;
  receiptHash: string | null;
  status: string;
}

export interface WalkthroughAnswer {
  capability: string;
  label: string;
  provider: string | null;
  facts: Record<string, string | number | boolean | null>;
  signalHash: string | null;
  receiptHash: string | null;
  costUsdCents: number | null;
  /** The verification verdict and, for a recorded answer, why it is not
   *  independently verified ("hash_mismatch" is a verification failure). */
  verification: string;
  verificationReason: string | null;
  verificationNote: string | null;
}

export interface DeskWalkthrough {
  reference: string;
  type: string;
  typeLabel: string;
  subject: Record<string, string>;
  steps: {
    /** 1 — what was asked, as entered, and what the network declares it cannot answer. */
    inputs: {
      fields: Array<{ name: string; value: string }>;
      declaredInputs: Array<{ label: string; value: string }>;
      unsupported: Array<{ label: string; requirement: string; reason: string }>;
      missingInputs: Array<{ capability: string; required: string[] }>;
    };
    /** 2 — the budget ceiling and the human approval that released it. */
    budgetApproval: Array<{
      mode: string;
      ceilingUsdCents: number;
      spentUsdCents: number;
      taskState: string;
      approved: boolean;
      approvalDetail: string | null;
      allowedActions: string[];
    }>;
    /** 3 — the actual paid Telegraph requests, one line per ask. */
    paidRequests: WalkthroughRequest[];
    /** 4 — the provider responses and receipts, facts verbatim. */
    providerResponses: WalkthroughAnswer[];
    /** 5 — the independent verification outcomes, failures named as such. */
    verification: Array<{
      capability: string;
      label: string;
      outcome: "independently_verified" | "verification_failed" | "node_asserted" | "not_purchased";
      detail: string;
      signalHash: string | null;
      receiptHash: string | null;
    }>;
    /** 6 — what disagreed, what is missing, what the network cannot answer. */
    discrepanciesAndGaps: {
      discrepancies: Array<{ title: string; detail: string; material: boolean | null; evidenceIds: string[] }>;
      missingEvidence: Array<{ capability: string; title: string }>;
      unsupported: Array<{ label: string; reason: string }>;
    };
    /** 7 — the final underwriting assessment, verbatim from the report. */
    assessment: {
      verdict: string;
      verdictLabel: string;
      summary: string;
      confidence: string;
      counts: NonNullable<DeskInvestigation["report"]>["counts"];
      nextActions: Array<{ title: string; detail: string }>;
      limitations: string[];
    } | null;
  };
  generatedAt: string;
}

function evidenceFacts(e: DeskEvidence): Record<string, string | number | boolean | null> {
  return e.facts;
}

export function buildDeskWalkthrough(inv: DeskInvestigation, tasks: TaskRecord[]): DeskWalkthrough {
  const verified = inv.evidence.filter((e) => e.provenance === "verified");
  const failed = inv.evidence.filter((e) => e.provenance === "verification_failed");
  const nodeAsserted = inv.evidence.filter((e) => e.class === "node_asserted");
  const declared = inv.evidence.filter((e) => e.class === "declared");
  const missingEvidence = inv.evidence.filter((e) => e.provenance === "missing");
  const inputGaps = inv.evidence.filter((e) => e.id.startsWith("input-gap:"));

  // 3 + 5: the capability report of each completed run is the ground truth for
  // what was asked, what it cost, and how each answer verified.
  type VerificationEntry = DeskWalkthrough["steps"]["verification"][number];
  const paidRequests: WalkthroughRequest[] = [];
  const verification: VerificationEntry[] = [];
  for (const run of inv.runs) {
    const task = tasks.find((t) => t.id === run.taskId);
    const dims = task?.result?.capabilityReport?.dimensions ?? [];
    for (const dim of dims) {
      if (dim.status === "gap" || dim.status === "routable_unverified") continue;
      paidRequests.push({
        capability: dim.dimension,
        label: dim.label,
        provider: dim.provider ?? null,
        intent: dim.intent ?? null,
        priceUsdCents: dim.priceUsdCents ?? null,
        signalHash: dim.signalHash ?? null,
        receiptHash: dim.receiptHash ?? null,
        status: dim.status,
      });
      const outcome =
        dim.status === "verified"
          ? ("independently_verified" as const)
          : dim.verificationReason === "hash_mismatch"
            ? ("verification_failed" as const)
            : dim.status === "recorded"
              ? ("node_asserted" as const)
              : ("not_purchased" as const);
      verification.push({
        capability: dim.dimension,
        label: dim.label,
        outcome,
        detail: dim.detail,
        signalHash: dim.signalHash ?? null,
        receiptHash: dim.receiptHash ?? null,
      });
    }
  }
  // Absorbed ledger records that predate a retained capability report still
  // carry their verification state — surface them from the evidence ledger.
  for (const e of [...verified, ...failed, ...nodeAsserted]) {
    if (verification.some((v) => v.capability === e.capability)) continue;
    verification.push({
      capability: e.capability,
      label: e.label,
      outcome: e.provenance === "verified" ? "independently_verified" : e.provenance === "verification_failed" ? "verification_failed" : "node_asserted",
      detail: e.detail,
      signalHash: e.signalHash ?? null,
      receiptHash: e.receiptHash ?? null,
    });
  }

  // 4: provider responses come from the absorbed evidence (the committed
  // facts), including failed records — their values are retained for
  // investigation, clearly labelled by the verification step above.
  const providerResponses: WalkthroughAnswer[] = [...verified, ...failed, ...nodeAsserted].map((e) => ({
    capability: e.capability,
    label: e.label,
    provider: e.minerId ?? null,
    facts: evidenceFacts(e),
    signalHash: e.signalHash ?? null,
    receiptHash: e.receiptHash ?? null,
    costUsdCents: e.costUsdCents ?? null,
    verification: e.provenance === "verified" ? "independently re-derived" : e.provenance === "verification_failed" ? "FAILED independent re-derivation" : "node-asserted only",
    verificationReason: e.verificationReason ?? null,
    verificationNote: e.detail,
  }));

  // 2: per-run budget and the approval gate that released it.
  const budgetApproval = inv.runs.map((run) => {
    const task = tasks.find((t) => t.id === run.taskId);
    const approvalEvent = task?.events.find((ev) => /approved the .*plan|approval/i.test(ev.message) && ev.type !== "approval_required");
    return {
      mode: run.mode,
      ceilingUsdCents: run.ceilingUsdCents,
      spentUsdCents: task?.spend.spentUsdCents ?? 0,
      taskState: run.taskState,
      approved: run.mode === "free" || task?.state === "completed" || task?.state === "verifying" || task?.state === "executing",
      approvalDetail: approvalEvent?.message ?? (run.mode === "free" ? "free run: probes only, nothing signed" : null),
      allowedActions: task?.permissions.allowedActions ?? [],
    };
  });

  return {
    reference: inv.reference,
    type: inv.type,
    typeLabel: DESK_TYPE_LABEL[inv.type],
    subject: Object.fromEntries(Object.entries(inv.subject).filter(([k]) => k !== "spendLimitUsdCents")),
    steps: {
      inputs: {
        fields: Object.entries(inv.subject)
          .filter(([k]) => k !== "spendLimitUsdCents")
          .map(([name, value]) => ({ name, value })),
        declaredInputs: declared.map((e) => ({ label: e.label, value: String(e.facts.value ?? "") })),
        unsupported: inv.unsupported.map((g) => ({ label: g.label, requirement: g.requirement, reason: g.reason })),
        missingInputs: inputGaps.map((e) => ({
          capability: e.capability,
          required: (e.detail.match(/not supplied: ([^.]+)/) ?? [])[1]?.split(/;|,/).map((s) => s.trim()) ?? [],
        })),
      },
      budgetApproval,
      paidRequests,
      providerResponses,
      verification,
      discrepanciesAndGaps: {
        discrepancies: (inv.report?.discrepancies ?? []).map((d) => ({
          title: d.title,
          detail: d.detail,
          material: d.kind === "provider_disagreement" ? d.material === true : null,
          evidenceIds: d.evidenceIds,
        })),
        missingEvidence: missingEvidence.map((e) => ({ capability: e.capability, title: e.title })),
        unsupported: inv.unsupported.map((g) => ({ label: g.label, reason: g.reason })),
      },
      assessment: inv.report
        ? {
            verdict: inv.report.assessment.verdict,
            verdictLabel: DESK_VERDICT_LABEL[inv.report.assessment.verdict] ?? inv.report.assessment.verdict,
            summary: inv.report.assessment.summary,
            confidence: inv.report.confidence,
            counts: inv.report.counts,
            nextActions: inv.report.assessment.nextActions.map((a) => ({ title: a.title, detail: a.detail })),
            limitations: inv.report.limitations,
          }
        : null,
    },
    generatedAt: new Date().toISOString(),
  };
}
