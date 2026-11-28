import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractJsonObject,
  hunyuanChat,
  hunyuanConfig,
  hunyuanStructured,
  HunyuanAuthError,
  HunyuanCredentialsError,
  HunyuanRateLimitError,
  HunyuanResponseError,
  HunyuanSchemaError,
  HunyuanTimeoutError,
  setHunyuanTransportForTests,
} from "@/lib/hunyuan/client";
import { z } from "zod";

/**
 * The provider adapter contract, exercised against an INJECTED transport —
 * never against live Tencent infrastructure (no credentials are present in
 * CI). The tests assert the real request/response wire behavior: endpoint,
 * headers, model, json-mode handling, retry policy, timeout mapping, usage
 * parsing and local schema enforcement.
 */

const ENV_KEYS = ["HUNYUAN_API_KEY", "HUNYUAN_MODEL", "HUNYUAN_BASE_URL", "HUNYUAN_TIMEOUT_MS", "HUNYUAN_RETRY_DELAY_MS"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HUNYUAN_API_KEY = "test-key";
  process.env.HUNYUAN_MODEL = "hy4-flash";
  process.env.HUNYUAN_BASE_URL = "https://tokenhub-intl.tencentmaas.com/v1";
  process.env.HUNYUAN_RETRY_DELAY_MS = "1";
  delete process.env.HUNYUAN_TIMEOUT_MS;
  setHunyuanTransportForTests(null);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setHunyuanTransportForTests(null);
});

function okBody(content: string, model = "hy4-flash") {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
    model,
  };
}

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("hunyuan provider adapter", () => {
  it("reports missing credentials honestly", async () => {
    delete process.env.HUNYUAN_API_KEY;
    expect(hunyuanConfig()).toBeNull();
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanCredentialsError);
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toThrow(/HUNYUAN_API_KEY/);
  });

  it("builds the OpenAI-compatible request: endpoint, bearer auth, model, messages, json mode", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setHunyuanTransportForTests(async (url, init) => {
      calls.push({ url, init });
      return jsonRes(okBody("{}"));
    });
    const result = await hunyuanChat({ system: "be brief", user: "hello", jsonMode: true, temperature: 0.1, maxTokens: 512 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://tokenhub-intl.tencentmaas.com/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("hy4-flash");
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(512);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result.content).toBe("{}");
    expect(result.model).toBe("hy4-flash");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 45, totalTokens: 165 });
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("omits response_format when json mode is off", async () => {
    let body: Record<string, unknown> | null = null;
    setHunyuanTransportForTests(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return jsonRes(okBody("plain text"));
    });
    await hunyuanChat({ system: "s", user: "u" });
    expect(body && "response_format" in body).toBe(false);
  });

  it("falls back to a plain request when the provider rejects response_format with a 400", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    setHunyuanTransportForTests(async (_url, init) => {
      const parsed = JSON.parse(String(init.body));
      bodies.push(parsed);
      if (parsed.response_format) return new Response('{"error":"response_format is not supported"}', { status: 400 });
      return jsonRes(okBody('{"ok":true}'));
    });
    const result = await hunyuanChat({ system: "s", user: "u", jsonMode: true });
    expect(result.content).toBe('{"ok":true}');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBeDefined();
    expect("response_format" in bodies[1]).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it("retries a transient 500 once and succeeds", async () => {
    let attempts = 0;
    setHunyuanTransportForTests(async () => {
      attempts++;
      if (attempts === 1) return new Response("upstream boom", { status: 500 });
      return jsonRes(okBody("recovered"));
    });
    const result = await hunyuanChat({ system: "s", user: "u" });
    expect(attempts).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.content).toBe("recovered");
  });

  it("retries a 429 once and succeeds", async () => {
    let attempts = 0;
    setHunyuanTransportForTests(async () => {
      attempts++;
      if (attempts === 1) return jsonRes({ error: "slow down" }, 429);
      return jsonRes(okBody("ok"));
    });
    await expect(hunyuanChat({ system: "s", user: "u" })).resolves.toMatchObject({ content: "ok" });
    expect(attempts).toBe(2);
  });

  it("does not retry a deterministic 401 and maps it to HunyuanAuthError", async () => {
    let attempts = 0;
    setHunyuanTransportForTests(async () => {
      attempts++;
      return new Response('{"error":"invalid key"}', { status: 401 });
    });
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanAuthError);
    expect(attempts).toBe(1);
  });

  it("maps a persistent 429 to HunyuanRateLimitError", async () => {
    setHunyuanTransportForTests(async () => jsonRes({ error: "quota" }, 429));
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanRateLimitError);
  });

  it("maps an abort/timeout to HunyuanTimeoutError", async () => {
    setHunyuanTransportForTests(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    });
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanTimeoutError);
  });

  it("rejects a response without message content", async () => {
    setHunyuanTransportForTests(async () => jsonRes({ choices: [{ message: {} }], model: "hy4-flash" }));
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanResponseError);
  });

  it("rejects a network failure that persists across the retry", async () => {
    setHunyuanTransportForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(hunyuanChat({ system: "s", user: "u" })).rejects.toBeInstanceOf(HunyuanResponseError);
  });
});

describe("extractJsonObject", () => {
  it("parses direct JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses a fenced ```json block", () => {
    expect(extractJsonObject('Sure:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });
  it("locates the widest object span", () => {
    expect(extractJsonObject('The answer is {"a": {"b": 2}} as recorded.')).toEqual({ a: { b: 2 } });
  });
  it("throws when no object exists", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});

describe("hunyuanStructured", () => {
  it("validates against the application schema and passes the parsed data through", async () => {
    setHunyuanTransportForTests(async () => jsonRes(okBody('{"answer": 7}')));
    const schema = z.object({ answer: z.number() });
    const result = await hunyuanStructured<{ answer: number }>({ system: "s", user: "u" }, schema);
    expect(result.data.answer).toBe(7);
    expect(result.correctiveRetry).toBe(false);
    expect(result.chat.usage.totalTokens).toBe(165);
  });

  it("retries once with the validation issues fed back, then accepts", async () => {
    const users: string[] = [];
    setHunyuanTransportForTests(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      users.push(body.messages[1].content);
      if (users.length === 1) return jsonRes(okBody('{"answer": "not-a-number"}'));
      return jsonRes(okBody('{"answer": 42}'));
    });
    const schema = z.object({ answer: z.number() });
    const result = await hunyuanStructured<{ answer: number }>({ system: "s", user: "give me json" }, schema);
    expect(result.data.answer).toBe(42);
    expect(result.correctiveRetry).toBe(true);
    expect(users[1]).toContain("CORRECTIVE REPEAT");
    expect(users[1]).toContain("answer");
  });

  it("fails with HunyuanSchemaError when the structure never becomes valid", async () => {
    setHunyuanTransportForTests(async () => jsonRes(okBody('{"answer": "still wrong"}')));
    const schema = z.object({ answer: z.number() });
    await expect(hunyuanStructured<{ answer: number }>({ system: "s", user: "u" }, schema)).rejects.toBeInstanceOf(HunyuanSchemaError);
  });

  it("retries when the first reply is not parseable JSON at all", async () => {
    let calls = 0;
    setHunyuanTransportForTests(async () => {
      calls++;
      if (calls === 1) return jsonRes(okBody("I will not use json, sorry."));
      return jsonRes(okBody('{"answer": 3}'));
    });
    const schema = z.object({ answer: z.number() });
    const result = await hunyuanStructured<{ answer: number }>({ system: "s", user: "u" }, schema);
    expect(result.data.answer).toBe(3);
    expect(result.correctiveRetry).toBe(true);
    expect(calls).toBe(2);
  });
});
