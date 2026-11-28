import { z } from "zod";

/**
 * The APPLICATION schemas Hunyuan output is validated against. These are the
 * product's contracts, enforced locally regardless of what the provider
 * returns: an answer that does not satisfy them is an error (one corrective
 * retry, then a typed failure), never a rendered result.
 */

const evidenceIds = z.array(z.string().min(1)).max(12);

const severity = z.enum(["critical", "material", "minor", "info"]);

const basis = z.enum(["established_fact", "inference"]);

export const decisionAssuranceReviewSchema = z.object({
  subject: z.string().min(1),
  headline: z.string().min(1),
  materialFindings: z
    .array(
      z.object({
        title: z.string().min(1),
        severity,
        basis,
        explanation: z.string().min(1),
        significance: z.string().min(1),
        evidenceIds,
      }),
    )
    .max(12),
  establishedFacts: z.array(z.object({ statement: z.string().min(1), evidenceIds })).max(12),
  inferences: z.array(z.object({ statement: z.string().min(1), reasoning: z.string().min(1), evidenceIds })).max(10),
  unknowns: z.array(z.object({ question: z.string().min(1), whyMaterial: z.string().min(1) })).max(10),
  conflicts: z.array(z.object({ title: z.string().min(1), detail: z.string().min(1), evidenceIds })).max(10),
  missingEvidence: z
    .array(z.object({ requirement: z.string().min(1), whyMaterial: z.string().min(1), suggestedCapability: z.string().min(1) }))
    .max(10),
  risks: z.array(z.object({ title: z.string().min(1), detail: z.string().min(1), severity })).max(10),
  confidence: z.object({ level: z.enum(["high", "medium", "low"]), basis: z.string().min(1) }),
  conclusions: z.array(z.object({ statement: z.string().min(1), actionable: z.boolean(), evidenceIds })).max(8),
  recommendedVerification: z
    .array(z.object({ step: z.string().min(1), capability: z.string().min(1), tracesTo: z.string().min(1) }))
    .max(8),
  limitations: z.array(z.string().min(1)).max(10),
});

export type DecisionAssuranceReviewParsed = z.infer<typeof decisionAssuranceReviewSchema>;

/** Mission #02: the assessment Hunyuan returns for a batch of detected events. */
export const continuumAssessmentSchema = z.object({
  assessments: z
    .array(
      z.object({
        eventId: z.string().min(1),
        summary: z.string().min(1),
        materiality: z.enum(["material", "minor"]),
        recommendedAction: z.string().min(1),
      }),
    )
    .max(12),
});

export type ContinuumAssessmentParsed = z.infer<typeof continuumAssessmentSchema>;

/**
 * Traceability enforcement, applied AFTER schema validation: every cited id
 * must resolve to a context item the record actually carries. Returns the
 * offending (location, ids) pairs — an empty list means fully traceable.
 */
export function citationViolations(review: { materialFindings?: Array<{ evidenceIds?: string[] }>; establishedFacts?: Array<{ evidenceIds?: string[] }>; inferences?: Array<{ evidenceIds?: string[] }>; conflicts?: Array<{ evidenceIds?: string[] }>; conclusions?: Array<{ evidenceIds?: string[] }> }, allowedIds: ReadonlySet<string>): Array<{ location: string; ids: string[] }> {
  const violations: Array<{ location: string; ids: string[] }> = [];
  const sections: Array<[string, Array<{ evidenceIds?: string[] }> | undefined]> = [
    ["materialFindings", review.materialFindings],
    ["establishedFacts", review.establishedFacts],
    ["inferences", review.inferences],
    ["conflicts", review.conflicts],
    ["conclusions", review.conclusions],
  ];
  for (const [section, entries] of sections) {
    (entries ?? []).forEach((entry, index) => {
      const unknown = (entry.evidenceIds ?? []).filter((id) => !allowedIds.has(id));
      if (unknown.length > 0) violations.push({ location: `${section}[${index}]`, ids: unknown });
    });
  }
  return violations;
}
