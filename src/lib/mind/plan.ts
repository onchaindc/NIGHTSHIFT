import type { PlanStep, VerificationCriteria } from "@/lib/engine/types";
import { COUNTERPARTY_INTENT, COUNTERPARTY_PRIMARY_MINER } from "@/lib/counterparty/intel";
import type { MindEntity } from "./report";

/**
 * Mind investigation planner.
 *
 * Turns an investigation objective into the engine's plan vocabulary:
 *   mind_baseline    — FREE: the unpaid probe (validation + live pricing) and
 *                      the honest "without Telegraph" dossier.
 *   counterparty_ask — PAID: the specialist purchase through the existing
 *                      Counterparty Intelligence flow (one attempt, no retry,
 *                      drift-checked against the approved offer). Only runs
 *                      after the human approves the plan (engine gate).
 *   mind_report      — FREE: evidence evaluation, the with/without comparison
 *                      and the reasoned report (the completion step).
 *
 * The planner is deterministic and states every assumption it makes in plain
 * language; it never invents a company, a price or a capability.
 */

export type MindMode = "free" | "intel";

/** Framing verbs that mark an objective as an investigation order. */
const INVESTIGATION_FRAME =
  /\b(?:investigate|due diligence|vet|research|look into|check (?:on|up)?)\b/i;

const KNOWN_JURISDICTIONS = [
  "norway",
  "united states",
  "united kingdom",
  "germany",
  "france",
  "netherlands",
  "singapore",
  "japan",
  "switzerland",
  "sweden",
  "denmark",
  "finland",
  "canada",
  "australia",
  "estonia",
  "lithuania",
] as const;

const JURISDICTION_CODES: Record<string, string> = {
  norway: "NO",
  "united states": "US",
  "united kingdom": "GB",
  germany: "DE",
  france: "FR",
  netherlands: "NL",
  singapore: "SG",
  japan: "JP",
  switzerland: "CH",
  sweden: "SE",
  denmark: "DK",
  finland: "FI",
  canada: "CA",
  australia: "AU",
  estonia: "EE",
  lithuania: "LT",
};

export interface ParsedObjective {
  entity: MindEntity | null;
  assumptions: string[];
}

/**
 * Extract the counterparty entity from the objective. Preference order:
 *  1. an explicitly quoted name ("investigate \"Equinor ASA\""),
 *  2. the object of an investigation verb ("due diligence on Equinor ASA"),
 *  3. the whole objective, when it reads like a bare company name.
 * A trailing "in <jurisdiction>" clause becomes the jurisdiction (stated as
 * an assumption, never guessed silently).
 */
export function parseInvestigationObjective(objective: string): ParsedObjective {
  const assumptions: string[] = [];
  const text = objective.trim();
  if (!text) return { entity: null, assumptions };

  let company: string | null = null;
  let jurisdiction: string | undefined;

  // 1: quoted name wins outright.
  const quoted = /["“”']([^"“”']{2,120})["“”']/.exec(text);
  if (quoted) {
    company = quoted[1].trim();
  } else {
    // 2: object of an investigation verb.
    const framed = new RegExp(
      `${INVESTIGATION_FRAME.source}\\s+(?:the\\s+)?(?:company\\s+)?(.+)$`,
      "i",
    ).exec(text);
    if (framed) company = framed[1].trim().replace(/^(?:on|of|into|for|up|about)\s+/i, "");
  }

  // Jurisdiction: a trailing "in <jurisdiction>" clause on the objective (a
  // quoted company name is preserved verbatim, while a verb-framed or bare
  // name loses the clause).
  const textJ = /\bin\s+([A-Za-z][A-Za-z .'-]{2,40})\s*$/.exec(text);
  if (textJ) {
    const jRaw = textJ[1].trim().replace(/[.!?]+$/, "");
    const key = jRaw.toLowerCase();
    if (key in JURISDICTION_CODES) {
      jurisdiction = JURISDICTION_CODES[key];
      assumptions.push(`jurisdiction "${jRaw}" recognized as ${jurisdiction} from the objective text`);
    } else {
      jurisdiction = jRaw;
      assumptions.push(`jurisdiction "${jRaw}" is not a recognized code; passed through verbatim for the specialist to resolve`);
    }
    if (!quoted && company) {
      // The verb-framed company part carried the clause; strip it there too.
      const inCompany = new RegExp(`\\bin\\s+${jRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").exec(company);
      if (inCompany) company = company.slice(0, inCompany.index).trim();
    }
  }

  // 3: bare-name fallback — the whole objective minus a jurisdiction clause.
  if (!company) {
    const bare = text;
    const jMatch = /\bin\s+([A-Za-z][A-Za-z .'-]{2,40})\s*$/.exec(bare);
    let candidate = jMatch ? bare.slice(0, jMatch.index).trim() : bare;
    candidate = candidate.replace(/[.!?]+$/, "").trim();
    if (candidate.length >= 2 && candidate.length <= 120 && !/\?$/.test(text)) {
      company = candidate;
      assumptions.push(
        jMatch
          ? `no explicit investigation verb was found, so the objective "${text}" was read as a bare company name with a jurisdiction clause`
          : `no explicit investigation verb was found, so the objective "${text}" was read as a bare company name`,
      );
    } else {
      return { entity: null, assumptions };
    }
  }

  company = (company ?? "").replace(/\s*[.!?]+$/, "").trim();
  if (company.length < 2) return { entity: null, assumptions };
  return { entity: { company, ...(jurisdiction ? { jurisdiction } : {}) }, assumptions };
}

export interface MindPlan {
  steps: PlanStep[];
  criteria: VerificationCriteria;
  assumptions: string[];
  entity: MindEntity | null;
  /** Set instead of a plan when no entity can be parsed: nothing runs, nothing spends. */
  blocker?: string;
}

function entityTarget(entity: MindEntity): string {
  return JSON.stringify(entity);
}

/**
 * Build the investigation plan for one objective.
 *  - mode "intel": baseline → paid specialist ask → comparison report. The
 *    engine's human approval gate (requiresApproval) covers the paid step;
 *    the plan itself pins the intent/miner exactly as Counterparty does.
 *  - mode "free": baseline → report only. The report then states plainly
 *    what specialist intelligence would have added and what it costs (the
 *    unpaid probe returns the live price).
 */
export function planMindInvestigation(objective: string, mode: MindMode): MindPlan {
  const parsed = parseInvestigationObjective(objective);
  if (!parsed.entity) {
    return {
      steps: [],
      criteria: {
        primaryVerifiedAgainstNodeSignal: false,
        answerSane: false,
        answerMaxAgeSeconds: 0,
        ownPaymentSettledOnChain: false,
        reconcileLedgerEntries: false,
      },
      assumptions: parsed.assumptions,
      entity: null,
      blocker:
        "the objective does not name a company to investigate, so no investigation was planned and nothing was spent",
    };
  }

  const entity = parsed.entity;
  const entityLabel = entity.jurisdiction ? `${entity.company} (${entity.jurisdiction})` : entity.company;
  const criteria: VerificationCriteria = {
    primaryVerifiedAgainstNodeSignal: mode === "intel",
    answerSane: mode === "intel",
    answerMaxAgeSeconds: 0,
    ownPaymentSettledOnChain: false,
    reconcileLedgerEntries: mode === "intel",
    primarySource: mode === "intel" ? "telegraph" : "free",
    goalIntent: "information",
  };

  const steps: PlanStep[] = [
    {
      id: "mind-baseline",
      kind: "mind_baseline",
      description: `Unpaid pre-flight for ${entityLabel}: validate the ${COUNTERPARTY_INTENT} ask against the network and assemble the without-intelligence dossier`,
      target: entityTarget(entity),
    },
  ];
  if (mode === "intel") {
    steps.push({
      id: "mind-counterparty-ask",
      kind: "counterparty_ask",
      description: `PAID specialist intelligence (Telegraph, pinned intent ${COUNTERPARTY_INTENT} at ${COUNTERPARTY_PRIMARY_MINER}) for ${entityLabel} — one attempt, no retry, refuses if the live offer drifted from the approved one`,
      target: entityTarget(entity),
    });
  }
  steps.push({
    id: "mind-report",
    kind: "mind_report",
    description: `Evaluate the evidence and produce the reasoned report${
      mode === "intel" ? " with the with/without-Telegraph comparison" : " (free mode: no specialist purchase)"
    }`,
    target: entityTarget(entity),
  });

  return { steps, criteria, assumptions: parsed.assumptions, entity };
}
