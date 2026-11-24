/**
 * Minds by Animoca Brands — Builder API adapter.
 *
 * Official interface verified 2026-11-24 from
 * https://build.hellominds.ai/docs/get-started/client-library and the live
 * API host:
 *  - base host: api.build.hellominds.ai
 *  - auth: `X-Api-Key` with a Builder API key (OAuth access tokens use
 *    `Authorization: Bearer`; this server integration runs as the account).
 *    `X-Access-Key` and `X-Builder-Api-Key` are not sent.
 *  - messaging: a stable alias must first be bound to a Mind
 *    (`POST /v1/messaging/conversation`, or `minds chat create`). Sending is
 *    `POST /v1/messaging/message` with `{alias, messageText}`.
 *
 * Access is deliberately environment-gated: without
 * `MINDS_BUILDER_API_KEY` and a pre-bound `MINDS_BUILDER_ALIAS`, nothing is
 * sent. The official endpoint is the default; `MINDS_BUILDER_SEND_URL` is an
 * optional enterprise/proxy override, never a guessed path.
 *
 * A live unauthenticated POST to /v1/messaging/message returns a structured
 * build-mode validation error naming the x-api-key header, which is how the
 * route and auth boundary were verified without a credential. No message has
 * been delivered from this workspace.
 *
 * The receiving half of the round trip lives in `builder-receive.ts` and uses
 * the official client library: pre-send fingerprint capture, the bounded
 * `waitForReply`, and a deferred `getHistory` collect that correlates rows
 * with the library's own reply matcher. Both halves share the same
 * environment gate (MINDS_BUILDER_API_KEY + MINDS_BUILDER_ALIAS).
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

export const MINDS_BUILDER_ENDPOINT = "https://api.build.hellominds.ai/v1/messaging/message";

export function mindsBuilderConfigured(): boolean {
  return !!(process.env.MINDS_BUILDER_API_KEY && process.env.MINDS_BUILDER_ALIAS);
}

/** The configured bound alias, trimmed; undefined when absent or blank. */
export function mindsBuilderAlias(): string | undefined {
  return process.env.MINDS_BUILDER_ALIAS?.trim() || undefined;
}

/** The exact text a report delivery carries — also the documented reply-correlation anchor. */
export function reportMessage(input: MindNotifyInput): string {
  const lines = [
    "NIGHTSHIFT investigation report",
    `Task: ${input.task.id}`,
    `Objective: ${input.report.objective}`,
    `State: ${input.task.state}`,
    `Confidence: ${input.report.confidence}`,
    `Intelligence used: ${input.report.intelUsed ? "paid, signal-verified" : "free preflight only"}`,
    "",
    input.task.summary ? `Summary: ${input.task.summary}` : "",
    "",
    "Reasoning:",
    ...input.report.reasoning.map((r) => `- ${r}`),
    "",
    "Evidence hashes and receipts are in the NIGHTSHIFT task record. Unsupported dimensions are named, never inferred.",
  ];
  return lines.filter((l) => l !== undefined).join("\n").slice(0, 12_000);
}

export async function notifyMindReport(
  input: MindNotifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MindNotifyResult> {
  const key = process.env.MINDS_BUILDER_API_KEY;
  const alias = process.env.MINDS_BUILDER_ALIAS?.trim();
  if (!key || !alias) {
    return {
      ok: false,
      detail:
        "not_configured: set MINDS_BUILDER_API_KEY and MINDS_BUILDER_ALIAS (an alias already bound to a Mind) to enable delivery on the official /v1/messaging/message endpoint",
    };
  }
  const sendUrl = process.env.MINDS_BUILDER_SEND_URL?.trim() || MINDS_BUILDER_ENDPOINT;

  try {
    const res = await fetchImpl(sendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": key,
      },
      body: JSON.stringify({
        alias,
        messageText: reportMessage(input),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        detail: `http_error: Minds returned HTTP ${res.status} ${body.slice(0, 200)}`,
      };
    }
    return { ok: true, detail: `Minds accepted the report for alias "${alias}" (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
