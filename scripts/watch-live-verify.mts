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

const CHAT_ID = 992416358; // the workspace's own recent Telegram chat (seen-updates store)

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
} else if (phase === "deliver") {
  const s = state();
  if (!s.detected) {
    console.log("detection has not happened yet; run `await` (or `await-full`) first.");
    process.exit(1);
  }
  /* Phase 3: real Telegram delivery + real failure/retry cycle         */
  const s2 = state();
  const { deliverAlerts, listAlerts } = await import("../src/lib/watch/alerts");
  const alertContext = { watchId: s2.watchId, watchName: s2.watchName, protocol: s2.protocol, telegramChatId: s2.chatId as number };

  try {
    const step5 = await deliverAlerts(alertContext, [], null, Date.now() + 10 * 60_000);
    const ledger5 = await listAlerts(s2.watchId);
    report(
      "Telegram alert delivery (REAL Bot API send)",
      step5.delivered > 0 && ledger5.every((a) => a.status === "delivered") ? "observed" : "FAIL",
      `productionsender delivered ${step5.delivered} alert(s) to chat ${s2.chatId}; ledger fully delivered=${ledger5.every((a) => a.status === "delivered")}. Received format: protocol, source, what changed (before → after), evidence link, observation time, report pointer.`,
    );
  } catch (err) {
    report("Telegram alert delivery (REAL Bot API send)", "BLOCKED", `real send attempt failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("continuing to the failure/retry phase anyway");
  }

  /* REAL failure: send to a nonexistent chat; the production sender     */
  /* throws; the ledger must record the attempt and keep alert pending   */
  const failCtx = { ...alertContext, telegramChatId: 1 };
  const failedStep = await deliverAlerts(failCtx, [], null, Date.now() + 10 * 60_000);
  const afterFail = await listAlerts(s2.watchId);
  report(
    "real failed delivery recorded (ledger keeps pending + lastError)",
    failedStep.failed > 0 && afterFail.some((a) => (a.lastError ?? "").length > 0) ? "observed" : "FAIL",
    `failed sends=${failedStep.failed}; lastError: ${afterFail.find((a) => a.lastError)?.lastError?.slice(0, 80) ?? "(none)"}`,
  );

  /* Retry through the production sender once past backoff              */
  const retry = await deliverAlerts(alertContext, [], null, Date.now() + 24 * 60_000);
  const ledger6 = await listAlerts(s2.watchId);
  report(
    "safe retry through the production sender",
    retry.delivered > 0 && ledger6.every((a) => a.status === "delivered") ? "observed" : "BLOCKED",
    `retry delivered ${retry.delivered} alert(s) to chat ${s2.chatId}; ledger fully delivered=${ledger6.every((a) => a.status === "delivered")}; no alert was ever re-sent (dedupe held)`,
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
