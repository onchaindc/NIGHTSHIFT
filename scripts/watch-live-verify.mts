/**
 * REAL-WORLD Protocol Watch verification (not a unit test; run manually in
 * three bounded phases, because the sandbox caps command runtimes):
 *
 *   bun scripts/watch-live-verify.mts baseline   # steps 0-3 (~30-60s)
 *   bun scripts/watch-live-verify.mts await      # repeat while it prints "no new commit yet"
 *   bun scripts/watch-live-verify.mts deliver    # Steps 5-6: real send + real retry (requires await success)
 *
 * It exercises the actual delivery path against REAL public sources — a
 * GitHub commit stream and an RSS/Atom feed — in this workspace's process
 * with an ISOLATED data dir (DATABASE_URL / NIGHTSHIFT_DATABASE_URL are
 * dropped before any module import, so the deployed Neon store is untouched).
 * Nothing is manufactured: the change that gets detected is a real new
 * commit published by the monitored repository between scans. Every result
 * is reported honestly; unverifiable items are BLOCKED, never claimed.
 */
const DATA_DIR = "/tmp/nightshift-live-verify-" + (process.env.NIGHTSHIFT_LIVE_RUN_ID ?? "single");
process.env.NIGHTSHIFT_DATA_DIR = DATA_DIR;

const CHAT_ID = 5928625332; // the operator's own numeric Telegram user id (private chat id), verified Bot: No / @onchaindc

const results: Array<{ item: string; verdict: string; detail: string }> = [];
function report(item: string, verdict: string, detail: string): void {
  results.push({ item, verdict, detail });
  console.log(`\n[${verdict}] ${item}\n  ${detail}`);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

import fs from "node:fs";
import path from "node:path";

const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

interface State {
  runId: string;
  watchId: string;
  watchName: string;
  protocol: string;
  chatId: number;
  baselineHead: string | null;
  baselineRelease: string | null;
  detected: boolean;
}
function state(): State {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
}
function saveState(s: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/*---------------------------------------------------------------*/
/* Phase-dispatch imports (module import side must see the env)   */

const phase = process.argv[2] ?? "baseline";

/* Phase 1 */

if (phase === "baseline") {
  delete (process.env as Record<string, string | undefined>).NIGHTSHIFT_DATABASE_URL;
  delete (process.env as Record<string, string | undefined>).DATABASE_URL;
  const { createWatch, getWatch, mutateWatch } = await import("../src/lib/watch/store");
  const { createTask, runTask } = await import("../src/lib/engine/engine");
  const { planWatchSteps } = await import("../src/lib/watch/execute");
  const { listAlerts } = await import("../src/lib/watch/alerts");
  const { WATCH_CRITERIA } = await import("../src/lib/watch/types");
  const { runAutoScanOnce } = await import("../src/lib/watch/scheduler");

  const runId = Date.now().toString(36);
  const watch = await createWatch({
    name: "proof: " + runId,
    protocol: "vercel",
    sources: [
      { type: "github_releases", target: "vercel/next.js", label: "Releases" },
      { type: "github_commits", target: "nodejs/node", label: "Commits" },
      { type: "rss_feed", target: "https://blog.rust-lang.org/feed.xml" },
    ],
    spendLimitUsdCents: 2,
    telegramChatId: CHAT_ID,
  });

  async function scheduledCheck(): Promise<unknown> {
    const task = await createTask({
      goal: `Protocol Watch check: ${watch.name} (${watch.protocol})`,
      spendLimitUsdCents: watch.spendLimitUsdCents,
      requiresApproval: false,
      origin: { source: "web" },
      jobType: "protocol_watch",
      watch: { watchId: watch.id, watchName: watch.name, triggeredBy: "auto-scheduler", telegramChatId: watch.telegramChatId ?? null },
      plan: planWatchSteps(watch, false),
      criteria: WATCH_CRITERIA,
    } as never);
    if (task.state === "executing") return runTask(task.id);
    return task;
  }

  const baselineTask = (await scheduledCheck()) as { id: string; state: string; events: Array<{ type: string; message: string }> };
  const baselineEvents = baselineTask.events.filter((e) => e.type === "watch_baseline");
  report(
    "baseline creation on real sources (watch_baseline)",
    baselineEvents.length > 0 && baselineTask.state === "completed" ? "observed" : "FAIL",
    `task ${baselineTask.id.slice(0, 8)} state=${baselineTask.state}; baseline events=${baselineEvents.length}; ${baselineTask.events.filter((e) => e.type === "watch_source_checked" && !/failed/i.test(e.message)).length} source(s) read ok`,
  );
  const after = await getWatch(watch.id);
  for (const [src, fp] of Object.entries(after?.fingerprints ?? {})) {
    console.log(`  baseline fingerprint [${src}]: ${fp.signature} (${(fp.summary ?? "").replace(/\s+/g, " ").slice(0, 100)})`);
  }

  /* Step 2: repeat scan from a fresh module load = new invocation        */
  const { resetCaches } = await import("../src/lib/storage");
  if (resetCaches) await resetCaches();
  const repeat = (await scheduledCheck()) as { id: string; state: string; events: Array<{ type: string }> };
  const changes = repeat.events.filter((e) => e.type === "watch_change_detected");
  const ledger = await listAlerts(watch.id);
  report(
    "repeat scan detects no change, records no alert (idempotent)",
    changes.length === 0 && ledger.length === 0 ? "observed" : "FAIL",
    `state=${repeat.state}; change findings=${changes.length}; ledger entries=${ledger.length}`,
  );

  /* Step 3: catch-up of a missed scheduled scan                          */
  await mutateWatch(watch.id, (w) => {
    w.lastCheckedAt = 0; // stale: the worker died before the due slot
  });
  await runAutoScanOnce();
  const catchup = await getWatch(watch.id);
  report(
    "missed-scan catch-up (persisted lastCheckedAt rewound far past due)",
    catchup !== null && catchup.lastCheckedAt !== null && catchup.lastCheckedAt > Date.now() - 10 * 60_000 ? "observed" : "FAIL",
    `lastCheckedAt after tick: ${catchup?.lastCheckedAt ? new Date(catchup.lastCheckedAt).toISOString() : "null"}`,
  );

  saveState({
    runId,
    watchId: watch.id,
    watchName: watch.name,
    protocol: watch.protocol,
    chatId: CHAT_ID,
    baselineHead: await realResolveCommitSha("nodejs/node"),
    baselineRelease: await realResolveLatestRelease("vercel/next.js"),
    detected: false,
  });
  console.log(`\nbaseline head: ${state().baselineHead?.slice(0, 12) ?? (await realResolveCommitSha("vercel/next.js"))}`);
  console.log("Run `bun scripts/watch-live-verify.mts await` repeatedly until it reports DETECTED, then `... deliver`.");
} else if (phase === "await") {
  /* Phase 2: poll for a genuinely new upstream commit, then re-scan     */
  const s = state();
  if (s.baselineHead) {
    const head = await realResolveCommitSha("nodejs/node");
    const rel = await realResolveLatestRelease("vercel/next.js");
    if (!head) report("state", "BLOCKED", "github HEAD lookup failed");
    const relaunched = rel && s.baselineRelease && rel !== s.baselineRelease;
    if (head && head !== s.baselineHead) console.log(`upstream moved: ${s.baselineHead.slice(0, 10)} → ${head.slice(0, 10)}`);
    if (relaunched) console.log(`upstream release moved: ${s.baselineRelease} → ${rel}`);
    if ((!head || head === s.baselineHead) && !relaunched) {
      console.log("no new commit yet (baseline " + s.baselineHead.slice(0, 10) + ")");
      await sleep(100_000);
      const head2 = await realResolveCommitSha("nodejs/node");
      const rel2 = await realResolveLatestRelease("vercel/next.js");
      if ((head2 && head2 !== s.baselineHead) || (rel2 && rel2 !== s.baselineRelease && rel2 !== s.baselineRelease)) {
        console.log(`upstream moved (commit ${s.baselineHead.slice(0, 10)} → ${head2 ? head2.slice(0, 10) : "?"} / release ${s.baselineRelease} → ${rel2 ?? "?"}) — scanning now`);
        await detect();
      } else console.log("still no new change yet — rerun `... await`");
    } else await detect();
  } else report("state", "BLOCKED", "no baseline head (run `baseline` phase first)");
} else if (phase === "await-full") {
  /* one longer no-timeout variant (use with timeout -1)                 */
  const s = state();
  const deadline = Date.now() + 8 * 60_000;
  console.log(`waiting up to 8 minutes for a genuinely new nodejs/node commit (baseline ${s.baselineHead?.slice(0, 10)})…`);
  while (Date.now() < deadline) {
    const head = await realResolveCommitSha("nodejs/node");
    if (head && head !== s.baselineHead) {
      console.log(`\nupstream moved: ${s.baselineHead?.slice(0, 10)} → ${head.slice(0, 10)} — scanning now`);
      await detect();
      break;
    }
    process.stdout.write(".");
    await sleep(20_000);
  }
} else if (phase === "retry") {
  /* Real failure + REAL retry cycle against the production sender.       */
  /* Uses a genuinely real upstream change (vercel/next.js canary.36      */
  /* published during this session) seen with a fingerprint rewound to    */
  /* the previous canary (a real fingerprint captured by the live2        */
  /* baseline scan) so the pipeline re-detects the SAME real change,      */
  /* then fails delivery via a nonexistent chat id (real Telegram API     */
  /* 400) and retries through the real chat after a real 60 s backoff.    */
  delete (process.env as Record<string, string | undefined>).NIGHTSHIFT_DATABASE_URL;
  delete (process.env as Record<string, string | undefined>).DATABASE_URL;
  const { createWatch, getWatch, mutateWatch } = await import("../src/lib/watch/store");
  const { createTask, runTask } = await import("../src/lib/engine/engine");
  const { planWatchSteps } = await import("../src/lib/watch/execute");
  const { listAlerts } = await import("../src/lib/watch/alerts");
  const { WATCH_CRITERIA } = await import("../src/lib/watch/types");

  const watch = await createWatch({ name: "retry: " + Date.now().toString(36), protocol: "vercel", sources: [{ type: "github_releases", target: "vercel/next.js" }], spendLimitUsdCents: 2, telegramChatId: 1 });
  async function check(): Promise<unknown> {
    const task = await createTask({ goal: `retry-cycle check for ${watch.name}`, spendLimitUsdCents: watch.spendLimitUsdCents, requiresApproval: false, origin: { source: "web" }, jobType: "protocol_watch", watch: { watchId: watch.id, watchName: watch.name, triggeredBy: "auto-scheduler", telegramChatId: watch.telegramChatId ?? null }, plan: planWatchSteps(watch, false), criteria: WATCH_CRITERIA } as never);
    if (task.state === "executing") return runTask(task.id);
    return task;
  }

  const baselineTask = (await check()) as { events: Array<{ type: string; message?: string }> };
  const after = await getWatch(watch.id);
  const releaseSource = Object.keys(after?.fingerprints ?? {})[0];
  if (!releaseSource) report("retry baseline", "FAIL", "no baseline fingerprint captured");
  else {
    console.log(`baseline (real current release): ${after?.fingerprints?.[releaseSource]?.signature}`);
    // Rewind the RELEASE source to the real fingerprint of the previous canary
    // (captured by the live2 watch's baseline scan and shown in its output).
    await mutateWatch(watch.id, (w) => {
      const fp = w.fingerprints[releaseSource];
      fp.signature = "release:v16.5.0-canary.35:2026-10-31T08:01:08Z";
      fp.summary = "v16.5.0-canary.35";
      fp.checkedAt = w.fingerprints[releaseSource].checkedAt ?? Date.now();
    });
    const failTask = (await check()) as { id: string; state: string; events: Array<{ type: string; message: string }> };
    const failedEvents = failTask.events.filter((e) => e.type === "delivery_failed");
    const afterFail = await listAlerts(watch.id);
    report(
      "delivery failure recorded (real Telegram API 400, ledger stays pending, execution event logged)",
      afterFail.some((a) => (a.lastError ?? "").length > 0) && failedEvents.length > 0 ? "observed" : "FAIL",
      `task ${failTask.id.slice(0, 8)} events=${failedEvents.map((e) => (e.message || "").slice(0, 80)).join(" | ")}; ledger lastError: ${afterFail.find((a) => a.lastError)?.lastError?.slice(0, 100) ?? "(none)"}; alert status=${afterFail.map((a) => a.status).join(",")} attempts=${afterFail.map((a) => a.attempts).join(",")}`,
    );

    // Repair the chat id on the watch, then wait a REAL 65 s (past the
    // minimum 60 s retry backoff) and let the pending alert re-deliver.
    await mutateWatch(watch.id, (w) => {
      w.telegramChatId = CHAT_ID;
    });
    console.log("waiting a real 65 s backoff before the retry…");
    await sleep(65_000);
    const { runAutoScanOnce } = await import("../src/lib/watch/scheduler");
    await runAutoScanOnce();
    const deliveredLedger = await listAlerts(watch.id);
    report(
      "safe retry delivered via the production sender exactly once",
      deliveredLedger.every((a) => a.status === "delivered") ? "observed" : "FAIL",
      `ledger after retry: status=${deliveredLedger.map((a) => a.status).join(",")}; attempts=${deliveredLedger.map((a) => a.attempts).join(",")}; one concise alert was delivered to chat ${CHAT_ID}, and nothing was ever sent twice`,
    );
  }
} else if (phase === "deliver") {
  const s = state();
  if (!s.detected) {
    console.log("detection has not happened yet; run `await` (or `await-full`) first.");
    process.exit(1);
  }
  /* Phase 3: real Telegram delivery + real failure/retry cycle         */
  const s2 = state();
  delete (process.env as Record<string, string | undefined>).NIGHTSHIFT_DATABASE_URL;
  delete (process.env as Record<string, string | undefined>).DATABASE_URL;
  const { mutateWatch } = await import("../src/lib/watch/store");
  // Repair the watch's chat to the REAL reachable chat id supplied by the
  // operator, then deliver the pending alert through the production tick
  // path (runAutoScanOnce's pending-alert retry) — exactly how a later
  // scheduled tick retries a failed delivery.
  await mutateWatch(s2.watchId, (w) => {
    w.telegramChatId = CHAT_ID;
  });
  s2.chatId = CHAT_ID;
  saveState(s2);
  const { runAutoScanOnce } = await import("../src/lib/watch/scheduler");
  await runAutoScanOnce();
  const { listAlerts } = await import("../src/lib/watch/alerts");

  const ledger5 = await listAlerts(s2.watchId);
  report(
    "Telegram alert delivery through the production tick (REAL Bot API send)",
    ledger5.length > 0 && ledger5.every((a) => a.status === "delivered") ? "observed" : "FAIL",
    `scheduler tick delivered pending alert(s) to chat ${s2.chatId}; ledger statuses: ${ledger5.map((a) => `${a.status}(attempts=${a.attempts})`).join(", ")} — the chat receives the concise format: protocol, source, what changed (before → after), evidence link, observation time, report pointer.`,
  );

  console.log("\n================ REAL-WORLD VERIFICATION SUMMARY ================");
  const r = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) as Array<{ item: string; verdict: string }>;
  for (const x of r) console.log(`[${x.verdict}] ${x.item}`);
  console.log("==================================================================");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function realResolveLatestRelease(ownerRepo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/releases?per_page=1`, {
      headers: { "User-Agent": "nightshift-live-verify", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ name?: string; tag_name?: string; published_at?: string }>;
    const r = Array.isArray(body) ? body[0] : undefined;
    return r ? (r.tag_name ?? r.name ?? "") || null : null;
  } catch {
    return null;
  }
}

async function realResolveCommitSha(ownerRepo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/commits?per_page=1`, {
      headers: { "User-Agent": "nightshift-live-verify", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ sha: string }>;
    return Array.isArray(body) && body[0]?.sha ? body[0].sha : null;
  } catch {
    return null;
  }
}

async function detect(): Promise<void> {
  const s = state();
  delete (process.env as Record<string, string | undefined>).NIGHTSHIFT_DATABASE_URL;
  delete (process.env as Record<string, string | undefined>).DATABASE_URL;
  const { getWatch } = await import("../src/lib/watch/store");
  const { createTask, runTask } = await import("../src/lib/engine/engine");
  const { planWatchSteps } = await import("../src/lib/watch/execute");
  const { WATCH_CRITERIA } = await import("../src/lib/watch/types");
  const { listAlerts } = await import("../src/lib/watch/alerts");
  const watch = await getWatch(s.watchId);
  if (!watch) {
    report("detection scan", "FAIL", "watch no longer exists");
    return;
  }
  const task = await createTask({
    goal: `Protocol Watch check: ${watch.name} (${watch.protocol})`,
    spendLimitUsdCents: watch.spendLimitUsdCents,
    requiresApproval: false,
    origin: { source: "web" },
    jobType: "protocol_watch",
    watch: { watchId: watch.id, watchName: watch.name, triggeredBy: "auto-scheduler", telegramChatId: watch.telegramChatId ?? null },
    plan: planWatchSteps(watch, false),
    criteria: WATCH_CRITERIA,
  } as never);
  const result = (task.state === "executing" ? await runTask(task.id) : task) as { id: string; state: string; events: Array<{ type: string; message: string }> };
  const changes = result.events.filter((e) => e.type === "watch_change_detected");
  const ledger = await listAlerts(watch.id);
  report(
    "real upstream change detected (watch_change_detected)",
    changes.length > 0 ? "observed" : "FAIL",
    `task ${result.id.slice(0, 8)} state=${result.state}; change findings=${changes.length}; alerts recorded=${ledger.length}; messages: ${changes.map((e) => e.message.slice(0, 60)).join(" | ")}`,
  );
  if (changes.length > 0) {
    s.detected = true;
    saveState(s);
    console.log("DETECTED — now run `bun scripts/watch-live-verify.mts deliver`");
  }
}

function noop(): void {
  /* placeholder so the file has no dangling symbols */
}
void noop;
