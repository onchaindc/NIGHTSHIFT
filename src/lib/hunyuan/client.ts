/**
 * Tencent Hunyuan provider adapter (TokenHub, OpenAI-compatible).
 *
 * A real server-side HTTP client for POST /chat/completions on the
 * OpenAI-compatible TokenHub endpoint. Server-only: the API key is read from
 * the environment at call time and never leaves the server — no route, log,
 * error message or browser bundle ever receives it.
 *
 * Verified against the TokenHub Hunyuan catalogue (tokenhub.com/providers/
 * tencent-hunyuan, read 2026-11-28): chat models hy3, hy4, hy4-flash and
 * hy4-preview. JSON-mode support is NOT documented per model, so this adapter
 * never assumes it: `jsonMode` is requested with response_format, and a 400
 * that names response_format/json retries the identical request WITHOUT it,
 * falling back to prompt-enforced JSON. Either way the APPLICATION schema is
 * enforced locally (zod, see schema.ts) — provider compliance is never taken
 * on trust.
 *
 * Reliability: per-call timeout, one automatic retry for transient failures
 * (network error, 429, 5xx), no retry for deterministic 4xx. Structured
 * requests get one corrective retry when the first answer fails schema
 * validation. Every failure is a typed error the callers map honestly; a
 * missing HUNYUAN_API_KEY is a credentials error, never a fake answer.
 */

/** The verified TokenHub Hunyuan model ids (see module doc). */
export const HUNYUAN_MODELS = ["hy3", "hy4", "hy4-flash", "hy4-preview"] as const;

export interface HunyuanConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  retryDelayMs: number;
}

/** Config is read per call so tests and runtime can change it dynamically. */
export function hunyuanConfig(): HunyuanConfig | null {
  const apiKey = process.env.HUNYUAN_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.HUNYUAN_MODEL?.trim() || "hy4-flash";
  const baseUrl = (process.env.HUNYUAN_BASE_URL?.trim() || "https://tokenhub-intl.tencentmaas.com/v1").replace(/\/+$/, "");
  const timeout = Number(process.env.HUNYUAN_TIMEOUT_MS);
  const retryDelay = Number(process.env.HUNYUAN_RETRY_DELAY_MS);
  return {
    apiKey,
    model,
    baseUrl,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1_000 ? timeout : 60_000,
    retryDelayMs: Number.isFinite(retryDelay) && retryDelay >= 0 ? retryDelay : 800,
  };
}

/** The env keys a live call needs; empty when the provider is usable. */
export function missingHunyuanCredentials(): string[] {
  return process.env.HUNYUAN_API_KEY?.trim() ? [] : ["HUNYUAN_API_KEY"];
}

export class HunyuanError extends Error {
  /** Upstream HTTP status when the failure came from a response. */
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "HunyuanError";
    this.status = status;
  }
}
export class HunyuanCredentialsError extends HunyuanError {
  constructor(missing: string[]) {
    super(`Tencent Hunyuan is not configured: set ${missing.join(", ")} to enable live inference.`);
    this.name = "HunyuanCredentialsError";
  }
}
export class HunyuanAuthError extends HunyuanError {
  constructor(detail: string, status: number) {
    super(`Hunyuan rejected the API key (HTTP ${status}): ${detail}`);
    this.name = "HunyuanAuthError";
  }
}
export class HunyuanRateLimitError extends HunyuanError {
  constructor(detail: string) {
    super(`Hunyuan rate limit (HTTP 429): ${detail}`);
    this.name = "HunyuanRateLimitError";
  }
}
export class HunyuanTimeoutError extends HunyuanError {
  constructor(timeoutMs: number) {
    super(`Hunyuan request timed out after ${timeoutMs}ms.`);
    this.name = "HunyuanTimeoutError";
  }
}
export class HunyuanResponseError extends HunyuanError {
  constructor(detail: string, status: number | null = null) {
    super(`Hunyuan response unusable: ${detail}`, status);
    this.name = "HunyuanResponseError";
  }
}
export class HunyuanSchemaError extends HunyuanError {
  issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super(`Hunyuan answer failed the application schema after the corrective retry (${issues.length} issue(s)).`);
    this.name = "HunyuanSchemaError";
    this.issues = issues;
  }
}

/** Injectable HTTP transport: tests substitute this, production uses fetch. */
export type HunyuanTransport = (url: string, init: RequestInit) => Promise<Response>;

let transportForTests: HunyuanTransport | null = null;

/** Test hook; production always uses the default fetch transport below. */
export function setHunyuanTransportForTests(fn: HunyuanTransport | null): void {
  transportForTests = fn;
}

function defaultTransport(): HunyuanTransport {
  const cfg = hunyuanConfig();
  return (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(cfg?.timeoutMs ?? 60_000) });
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function mapHttpError(status: number, bodyText: string): HunyuanError {
  const snippet = bodyText.slice(0, 300) || "(empty body)";
  if (status === 401 || status === 403) return new HunyuanAuthError(snippet, status);
  if (status === 429) return new HunyuanRateLimitError(snippet);
  return new HunyuanResponseError(`HTTP ${status}: ${snippet}`, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HunyuanUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface HunyuanChatInput {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object via response_format; degrades per module doc. */
  jsonMode?: boolean;
}

export interface HunyuanChatResult {
  content: string;
  model: string;
  finishReason: string | null;
  usage: HunyuanUsage;
  /** Actual HTTP attempts made (1 = no retry). */
  attempts: number;
  durationMs: number;
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

/** One chat completion with timeout + one transient retry. */
export async function hunyuanChat(input: HunyuanChatInput): Promise<HunyuanChatResult> {
  const cfg = hunyuanConfig();
  if (!cfg) throw new HunyuanCredentialsError(missingHunyuanCredentials());

  const startedAt = Date.now();
  const transport = transportForTests ?? defaultTransport();
  const body = (jsonMode: boolean) =>
    JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 4096,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });

  let attempts = 0;
  let lastError: HunyuanError | null = null;
  let allowJsonMode = input.jsonMode ?? false;

  // At most two network attempts plus at most one json-mode fallback: a 400
  // that names response_format retries once without it (undocumented JSON
  // mode per model — see module doc), everything else follows the retry rules.
  for (let round = 0; round < 2; round++) {
    let jsonRound = allowJsonMode;
    for (let inner = 0; inner < 2; inner++) {
      attempts++;
      let res: Response;
      try {
        res = await transport(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: body(jsonRound),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new HunyuanTimeoutError(cfg.timeoutMs);
        }
        lastError = new HunyuanResponseError(`network failure: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (res.ok) {
        let parsed: OpenAiChatResponse;
        try {
          parsed = (await res.json()) as OpenAiChatResponse;
        } catch {
          throw new HunyuanResponseError("response body is not JSON", res.status);
        }
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new HunyuanResponseError("response carried no message content", res.status);
        }
        const usage = parsed.usage ?? {};
        return {
          content,
          model: parsed.model ?? cfg.model,
          finishReason: parsed.choices?.[0]?.finish_reason ?? null,
          usage: {
            promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
            completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
            totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
          },
          attempts,
          durationMs: Date.now() - startedAt,
        };
      }
      const errText = await res.text().catch(() => "");
      const err = mapHttpError(res.status, errText);
      // Undocumented JSON mode: a 400 naming response_format falls back to a
      // plain request; the application schema still applies afterwards.
      if (res.status === 400 && jsonRound && /response_format|json/i.test(errText)) {
        jsonRound = false;
        continue; // same round, without response_format (does not count as transient retry)
      }
      lastError = err;
      if (!isTransientStatus(res.status)) throw err; // deterministic 4xx: no retry
      break; // transient: leave to the outer round
    }
    if (lastError && round === 0) {
      await sleep(cfg.retryDelayMs);
      lastError = null;
      continue;
    }
  }
  throw lastError ?? new HunyuanResponseError("request failed without a recorded error");
}

/**
 * Extract a JSON object from model content: direct parse, fenced ```json
 * block, or the widest {...} span. Never "repairs" values — it only locates
 * the object; schema validation happens on the parsed result.
 */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the locating strategies
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)); // throws with the real parse error
  }
  throw new HunyuanResponseError(`content carries no JSON object: ${trimmed.slice(0, 120)}`);
}

export interface HunyuanStructuredResult<T> {
  data: T;
  chat: HunyuanChatResult;
  /** True when the first answer failed validation and a corrective retry ran. */
  correctiveRetry: boolean;
}

/**
 * Structured output: JSON-mode chat → parse → validate against the
 * application zod schema → ONE corrective retry (the issues are fed back
 * verbatim) → HunyuanSchemaError. The schema is the app's, never the
 * provider's: a structurally invalid answer is an error, not a result.
 */
export async function hunyuanStructured<T>(
  input: HunyuanChatInput,
  schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: Array<{ path: Array<string | number | symbol>; message: string }> } } },
): Promise<HunyuanStructuredResult<T>> {
  const first = await hunyuanChat({ ...input, jsonMode: true });
  const firstParse = (() => {
    try {
      return { ok: true as const, value: extractJsonObject(first.content) };
    } catch (err) {
      return { ok: false as const, detail: err instanceof Error ? err.message : String(err) };
    }
  })();

  let candidate: unknown;
  if (firstParse.ok) {
    candidate = firstParse.value;
  } else {
    // Not parseable JSON at all: one corrective retry.
    const retry = await hunyuanChat({
      system: input.system,
      user: `${input.user}\n\nCORRECTIVE REPEAT — your previous reply was not parseable JSON (${firstParse.detail}). Reply with ONLY the JSON object.`,
      jsonMode: true,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    try {
      candidate = extractJsonObject(retry.content);
    } catch {
      throw new HunyuanResponseError(`neither reply was parseable JSON (${firstParse.detail})`);
    }
    const retried = schema.safeParse(candidate);
    if (retried.success) return { data: retried.data as T, chat: retry, correctiveRetry: true };
    throw new HunyuanSchemaError(retried.error!.issues.map(formatIssue));
  }

  const checked = schema.safeParse(candidate);
  if (checked.success) return { data: checked.data as T, chat: first, correctiveRetry: false };

  // Structurally wrong JSON: one corrective retry carrying the issues back.
  const issues = formatIssues(checked.error!.issues);
  const retry = await hunyuanChat({
    system: input.system,
    user: `${input.user}\n\nCORRECTIVE REPEAT — your previous JSON violated the required structure:\n${issues}\nReturn ONLY the corrected JSON object.`,
    jsonMode: true,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  });
  let retriedCandidate: unknown;
  try {
    retriedCandidate = extractJsonObject(retry.content);
  } catch (err) {
    throw new HunyuanSchemaError(checked.error!.issues.map(formatIssue));
  }
  const retried = schema.safeParse(retriedCandidate);
  if (retried.success) return { data: retried.data as T, chat: retry, correctiveRetry: true };
  throw new HunyuanSchemaError(retried.error!.issues.map(formatIssue));
}

function formatIssue(issue: { path: Array<string | number | symbol>; message: string }): { path: string; message: string } {
  return { path: issue.path.map(String).join("."), message: issue.message };
}

function formatIssues(issues: Array<{ path: Array<string | number | symbol>; message: string }>): string {
  return issues.map((i) => `- ${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}
