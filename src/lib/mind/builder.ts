/**
 * Minds by Animoca Brands — Builder API adapter (verified surface only).
 *
 * What is VERIFIED (2026-11-23):
 *  - Platform: Minds by Animoca Brands (hellominds.ai) is a persistent agentic
 *    AI platform; users instruct agents via email/messaging. Capabilities
 *    extend through the Bazaar as "Tools (API-connected apps)" — i.e. an
 *    externally reachable HTTP endpoint a Mind can call. That is exactly what
 *    /api/mind/investigations provides.
 *  - Builder API: keys are created in the Builder console
 *    (build.hellominds.ai/console → Keys → Create), shown once, TTL ~90 days.
 *    The key travels as header `X-Builder-Api-Key` (the deprecated
 *    `X-Access-Key` header may be sent alongside).
 *  - The API host api.build.hellominds.ai is live (structured JSON errors).
 *
 * What is NOT verifiable today, and therefore NOT invented here:
 *  - The exact message/send endpoint paths. The June-2026 measurement of the
 *    Builder API documented "list Minds / send message / SSE stream" plus a
 *    machine-readable spec at /docs/openapi.json; all of those paths return
 *    404 as of now, and the official npm client is unlicensed. Guessing a
 *    path would be simulating an integration, which this repo refuses to do.
 *  - Consequently outbound delivery runs ONLY when the operator supplies the
 *    full send URL (MINDS_BUILDER_SEND_URL) alongside the key
 *    (MINDS_BUILDER_API_KEY). Without both, delivery is skipped and reported
 *    honestly — the investigation itself never depends on it.
 *
 * The realistic path to full messaging access is the builder programme
 * (build.hellominds.ai/program), which is a human step outside this repo.
 */

export interface MindNotifyInput {
  task: {
    id: string;
    goal: string;
    state: string;
    summary?: string;
  };
  report: {
    objective: string;
    confidence: string;
    intelUsed: boolean;
    reasoning: string[];
  };
}

export interface MindNotifyResult {
  ok: boolean;
  /** "not_configured" | "sent" | "http_error" | "error" */
  detail: string;
}

export function mindsBuilderConfigured(): boolean {
  return !!(process.env.MINDS_BUILDER_API_KEY && process.env.MINDS_BUILDER_SEND_URL);
}

export async function notifyMindReport(
  input: MindNotifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MindNotifyResult> {
  const key = process.env.MINDS_BUILDER_API_KEY;
  const sendUrl = process.env.MINDS_BUILDER_SEND_URL;
  if (!key || !sendUrl) {
    return { ok: false, detail: "not_configured: set MINDS_BUILDER_API_KEY and MINDS_BUILDER_SEND_URL (the exact Builder API send path is not publicly documented, so it is never guessed)" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Builder-Api-Key": key,
  };
  // The deprecated header the official client still sends; harmless to omit.
  const legacy = process.env.MINDS_BUILDER_ACCESS_KEY;
  if (legacy) headers["X-Access-Key"] = legacy;

  try {
    const res = await fetchImpl(sendUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "nightshift.investigation.report",
        taskId: input.task.id,
        objective: input.report.objective,
        state: input.task.state,
        confidence: input.report.confidence,
        intelUsed: input.report.intelUsed,
        summary: input.task.summary,
        reasoning: input.report.reasoning,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `http_error: Minds send endpoint returned HTTP ${res.status} ${body.slice(0, 140)}` };
    }
    return { ok: true, detail: `Minds send endpoint accepted the report (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
