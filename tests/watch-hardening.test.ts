import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertHttpUrl,
  assertPublicTarget,
  isNotPublicIp,
  safeHttpGet,
  setSsrfResolverForTests,
  SsrfBlockedError,
  type ResolveFn,
} from "@/lib/watch/ssrf";
import { deleteWatch } from "@/lib/watch/store";
import { resetStore } from "@/lib/engine/store";
import { requestAuthorized } from "@/lib/api/auth";
import { setWatchDeps } from "@/lib/watch/execute";
import { runAutoScanOnce, resetSchedulerForTests, schedulerStatus, stopWatchScheduler, watchIntervalMs } from "@/lib/watch/scheduler";

/* ------------------------------------------------------------------ */
/* Isolated data dir per test run                                       */
/* ------------------------------------------------------------------ */

const dataDir = path.join(os.tmpdir(), `nightshift-hardening-${process.pid}-${Date.now()}`);
process.env.NIGHTSHIFT_DATA_DIR = dataDir;
process.env.NIGHTSHIFT_DEFAULT_SPEND_LIMIT_CENTS = "10";
delete process.env.NIGHTSHIFT_API_TOKEN;

/* ------------------------------------------------------------------ */
/* SSRF: IP classification                                              */
/* ------------------------------------------------------------------ */

describe("ssrf: address classification", () => {
  it("blocks private, loopback, link-local, metadata and reserved ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.1",
      "169.254.169.254", "0.0.0.0", "100.64.0.1", "192.0.2.55", "240.0.0.1", "224.0.0.5",
      "::1", "fe80::1", "fd00:ec2::254", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
    ]) {
      expect(isNotPublicIp(ip), `expected ${ip} to be blocked`).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "8.8.8.8"]) {
      expect(isNotPublicIp(ip), `expected ${ip} to be public`).toBe(false);
    }
  });

  it("rejects non-http URL schemes before any resolution", () => {
    expect(() => assertHttpUrl("file:///etc/passwd")).toThrow(SsrfBlockedError);
    expect(() => assertHttpUrl("gopher://example.com")).toThrow(SsrfBlockedError);
    expect(assertHttpUrl("https://example.com/x").hostname).toBe("example.com");
  });

  it("blocks URLs that resolve to any non-public address (metadata, loopback)", async () => {
    const resolve: ResolveFn = async (hostname) =>
      hostname === "metadata.threat.test" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    setSsrfResolverForTests(resolve);
    try {
      await expect(assertPublicTarget("http://metadata.threat.test/latest")).rejects.toThrow(/non-public address/);
      await expect(assertPublicTarget("http://local.threat.test/latest")).rejects.toThrow(/169\.254|127\.0\.0\.1/);
    } finally {
      setSsrfResolverForTests(null);
    }
  });

  it("allows URLs that resolve to public addresses only", async () => {
    const resolve: ResolveFn = async () => [{ address: "93.184.216.34", family: 4 }, { address: "8.8.8.8", family: 4 }];
    setSsrfResolverForTests(resolve);
    try {
      const t = await assertPublicTarget("https://docs.example.com/docs");
      expect(t.ip).toBe("93.184.216.34");
    } finally {
      setSsrfResolverForTests(null);
    }
  });

  it("revalidates every redirect hop, refusing a redirect to an internal address", async () => {
    const hops: string[] = [];
    let hopCalls = 0;
    const resolve: ResolveFn = async (hostname) => {
      if (hostname === "docs.example.com") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "internal.threat.test") return [{ address: "10.0.0.9", family: 4 }];
      throw new Error(`unexpected hostname ${hostname}`);
    };
    setSsrfResolverForTests(resolve);
    try {
      await expect(
        safeHttpGet("https://docs.example.com/page", {
          hop: async ({ url }) => {
            hopCalls++;
            hops.push(url.pathname);
            if (hopCalls === 1) return { status: 302, headers: { location: "https://internal.threat.test/latest" }, body: "" };
            throw new Error("must never fetch the blocked redirect target");
          },
        }),
      ).rejects.toThrow(/10\.0\.0\.9/);
      expect(hopCalls).toBe(1);
    } finally {
      setSsrfResolverForTests(null);
    }
  });

  it("follows public redirects and returns the final body", async () => {
    const resolve: ResolveFn = async (hostname) => {
      if (hostname === "docs.example.com") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "mirror.example.net") return [{ address: "8.8.8.8", family: 4 }];
      throw new Error(`unexpected hostname ${hostname}`);
    };
    setSsrfResolverForTests(resolve);
    try {
      let onMirror = false;
      const out = await safeHttpGet("https://docs.example.com/page", {
        hop: async ({ url }) => {
          if (!onMirror) {
            onMirror = true;
            // The first hop pins the ip; assert it actually fetched the real target.
            expect(url.hostname).toBe("docs.example.com");
            expect(url.pathname).toBe("/page");
            return { status: 302, headers: { location: "https://mirror.example.net/mirror" }, body: "" };
          }
          expect(url.hostname).toBe("mirror.example.net");
          expect(url.pathname).toBe("/mirror");
          return { status: 200, headers: { "content-type": "text/plain" }, body: "followed" };
        },
      });
      expect(out.status).toBe(200);
      expect(out.body).toBe("followed");
    } finally {
      setSsrfResolverForTests(null);
    }
  });

  it("refuses more redirects than the limit", async () => {
    const resolve: ResolveFn = async () => [{ address: "8.8.8.8", family: 4 }];
    setSsrfResolverForTests(resolve);
    try {
      let n = 0;
      await expect(
        safeHttpGet("https://loop.example.com/a", {
          hop: async () => {
            n++;
            return { status: 302, headers: { location: `/hop-${n}` }, body: "" };
          },
        }),
      ).rejects.toThrow(/too many redirects/);
      expect(n).toBe(4); // 1 initial + 3 redirect hops, then hard stop
    } finally {
      setSsrfResolverForTests(null);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Watch creation validates unsafe source URLs                          */
/* ------------------------------------------------------------------ */

function resetAll() {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  resetStore();
}

beforeEach(() => {
  resetAll();
  resetSchedulerForTests();
});
afterEach(async () => {
  delete process.env.NIGHTSHIFT_API_TOKEN;
  setSsrfResolverForTests(null);
  setWatchDeps({} as never);
  // Awaited so the lease cleanup cannot race the NEXT test's fresh state.
  await stopWatchScheduler();
});

describe("watch creation rejects unsafe targets", () => {
  it("never accepts a URL that resolves to a private or metadata address", async () => {
    const { createWatch, WatchValidationError } = await import("@/lib/watch/store");
    setSsrfResolverForTests(async () => [{ address: "169.254.169.254", family: 4 }]);
    await expect(
      createWatch({
        name: "bad",
        protocol: "P",
        sources: [{ type: "docs_url", target: "http://metadata.threat.test/latest" }],
      }),
    ).rejects.toThrow(WatchValidationError);
  });

  it("rejects GitHub sources that are not a clean owner/repo pair", async () => {
    const { createWatch, WatchValidationError } = await import("@/lib/watch/store");
    await expect(
      createWatch({
        name: "bad",
        protocol: "P",
        sources: [{ type: "github_releases", target: "../../../etc/passwd" }],
      }),
    ).rejects.toThrow(WatchValidationError);
    // A URL form IS accepted (normalized to owner/repo).
    const w = await createWatch({
      name: "ok",
      protocol: "Uniswap",
      sources: [{ type: "github_releases", target: "https://github.com/Uniswap/sdks/" }],
    });
    expect(w.sources[0].target).toBe("Uniswap/sdks");
  });
});

/* ------------------------------------------------------------------ */
/* Watch-management API authorization                                   */
/* ------------------------------------------------------------------ */

describe("watch-management api authorization", () => {
  it("allows requests when the operator token is not configured (open mode)", () => {
    delete process.env.NIGHTSHIFT_API_TOKEN;
    expect(requestAuthorized(new Request("http://localhost/api/watches", { method: "POST" }))).toBe(true);
  });

  it("requires a matching bearer token when NIGHTSHIFT_API_TOKEN is set", () => {
    process.env.NIGHTSHIFT_API_TOKEN = "s3cret-operator-token";
    expect(requestAuthorized(new Request("http://localhost/api/watches", { method: "POST" }))).toBe(false);
    expect(
      requestAuthorized(new Request("http://localhost/api/watches", { method: "POST", headers: { Authorization: "Bearer wrong" } })),
    ).toBe(false);
    expect(
      requestAuthorized(
        new Request("http://localhost/api/watches", { method: "POST", headers: { Authorization: "Bearer s3cret-operator-token" } }),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Scheduler: persistence, restart recovery, duplicate workers          */
/* ------------------------------------------------------------------ */

describe("scheduler reliability", () => {
  it("persists worker state that survives a restart and reports degraded honestly", async () => {
    // Simulate a first process that crashed after a failed scan.
    const crashState = {
      pid: 111,
      startedAt: Date.now() - 900_000,
      lastScanStartedAt: Date.now() - 800_000,
      lastScanCompletedAt: Date.now() - 700_000,
      lastSuccessAt: Date.now() - 2_000_000, // long stale
      lastError: "simulated hard crash under load: ENOSPC",
      consecutiveFailures: 3,
      skippedByOtherWorker: 0,
    };
    writeFileSync(path.join(dataDir, "scheduler-state.json"), JSON.stringify(crashState));

    // A NEW process reads the persisted state and reports the truth: the old
    // failure history survives, and this process arms itself to take over.
    const status = await schedulerStatus();
    expect(status.consecutiveFailures).toBe(3);
    expect(status.lastError).toContain("ENOSPC");
    expect(status.lastScanStartedAt).toBe(crashState.lastScanStartedAt);
    expect(status.startedAt).toBe(crashState.startedAt); // persisted timeline preserved
    expect(status.degraded).toBe(true);
    expect(status.degradedReason).toMatch(/failed|ENOSPC/);
    expect(status.activeInProcess).toBe(true); // this process armed and takes over
  });

  it("skips a tick while another worker holds a live lease, then works once it expires", async () => {
    const lockPath = path.join(dataDir, "scheduler.lock");
    // Another live worker:
    writeFileSync(lockPath, JSON.stringify({ pid: 999, takenAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 }));
    await runAutoScanOnce();
    expect(readFileSync(lockPath, "utf8")).toContain("999"); // ours did not steal it
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "scheduler-state.json"), "utf8"));
    expect(persisted.skippedByOtherWorker).toBeGreaterThan(0);

    // Lease expired: our worker steals it and runs.
    writeFileSync(lockPath, JSON.stringify({ pid: 999, takenAt: Date.now() - 99_000_000, expiresAt: Date.now() - 90_000_000 }));
    await runAutoScanOnce();
    expect(existsSync(lockPath)).toBe(false); // released after running
  });

  it("records a total source outage honestly: the scan completes and the failed run lands in history", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    setSsrfResolverForTests(async (hostname) => {
      if (hostname === "docs.example.com") return [{ address: "93.184.216.34", family: 4 }];
      return [];
    });
    setWatchDeps({
      fetchSource: async (source: { id: string; label: string }) => ({
        sourceId: source.id,
        sourceLabel: source.label,
        ok: false as const,
        error: "simulated source outage",
      }),
      sendTelegram: async () => {},
      lookupSignal: async () => {
        throw new Error("not used in free checks");
      },
    } as never);
    const watch = await createWatch({
      name: "outage watch",
      protocol: "simulated",
      sources: [{ type: "docs_url", target: "https://docs.example.com/docs" }],
    });
    expect(watch.lastCheckedAt).toBeNull();
    await runAutoScanOnce();
    // The worker tick itself SUCCEEDED (it ran end to end); the WATCH run
    // failed and that failure is persisted in the task record, not hidden.
    const stored = JSON.parse(readFileSync(path.join(dataDir, "tasks.json"), "utf8")) as Array<{ state: string; error: string | null }>;
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].state).toBe("failed");
    expect(stored[0].error).toMatch(/every configured source failed/);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "scheduler-state.json"), "utf8"));
    expect(persisted.consecutiveFailures).toBe(0); // the worker tick itself did not crash
    expect(persisted.lastSuccessAt).toBeTruthy();
    const after = await (await import("@/lib/watch/store")).getWatch(watch.id);
    expect(after?.lastCheckedAt).toBeGreaterThan(0); // the run happened and was recorded
  });

  it("keeps the interval config readable", () => {
    process.env.NIGHTSHIFT_WATCH_INTERVAL_MS = "45";
    expect(watchIntervalMs()).toBe(10 * 60 * 1000); // invalid too-small values fall back
    process.env.NIGHTSHIFT_WATCH_INTERVAL_MS = "120000";
    expect(watchIntervalMs()).toBe(120_000);
    delete process.env.NIGHTSHIFT_WATCH_INTERVAL_MS;
  });

  it("deletes watch configs safely (history still persists independently)", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    const w = await createWatch({ name: "temp", protocol: "x", sources: [{ type: "github_releases", target: "org/repo" }] });
    expect(await deleteWatch(w.id)).toBe(true);
    expect(await deleteWatch(w.id)).toBe(false);
  });

  it("reconciles a mid-run death: the stale watch task gets an honest terminal state and an interruption event", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    await createWatch({ name: "ghost", protocol: "ghost", sources: [{ type: "docs_url", target: "https://docs.example.com/p" }] });
    const { createTask } = await import("@/lib/engine/engine");
    // A check run that was accepted but whose worker died before any step:
    // state is executing and now the record freezes there forever unless a
    // later tick reconciles it.
    const stuck = await createTask({
      goal: "Protocol Watch check: ghost (ghost)",
      spendLimitUsdCents: 10,
      requiresApproval: false,
      origin: { source: "web" },
      jobType: "protocol_watch",
      plan: [{ kind: "watch_check", id: "step-check", description: "watch check" }],
    });
    expect(stuck.state).toBe("executing");
    const taskFile = path.join(dataDir, "tasks.json");
    const tasks = JSON.parse(readFileSync(taskFile, "utf8")) as Array<Record<string, unknown>>;
    const record = tasks.find((t) => t.id === stuck.id)!;
    record.updatedAt = Date.now() - 30 * 60_000; // idle well past the grace window
    writeFileSync(taskFile, JSON.stringify(tasks));
    resetStore(); // the engine's in-memory cache must not hide the rewind

    const { reconcileStaleWatchTasks } = await import("@/lib/watch/scheduler");
    const reconciled = await reconcileStaleWatchTasks(Date.now());
    expect(reconciled).toBe(1);
    const after = JSON.parse(readFileSync(taskFile, "utf8")) as Array<Record<string, unknown>>;
    const nowTerminated = after.find((t) => t.id === stuck.id)! as { state: string; error: string | null; events: Array<{ type: string }> };
    expect(nowTerminated.state).toBe("failed");
    expect(nowTerminated.error).toMatch(/interrupted/i);
    expect(nowTerminated.events.some((e) => e.type === "scan_interrupted")).toBe(true);

    // Idempotent: reconciling again (or a live-untouched record) does nothing.
    expect(await reconcileStaleWatchTasks(Date.now())).toBe(0);
  });

  it("a live-leaning run is not reconciled: the grace window keeps active workers safe", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    await createWatch({ name: "live", protocol: "live", sources: [{ type: "docs_url", target: "https://docs.example.com/p" }] });
    const { createTask } = await import("@/lib/engine/engine");
    const live = await createTask({
      goal: "Protocol Watch check: live (live)",
      spendLimitUsdCents: 10,
      requiresApproval: false,
      origin: { source: "web" },
      jobType: "protocol_watch",
      plan: [{ kind: "watch_check", id: "step-check", description: "watch check" }],
    });
    expect(live.state).toBe("executing"); // updatedAt is fresh
    const { reconcileStaleWatchTasks } = await import("@/lib/watch/scheduler");
    expect(await reconcileStaleWatchTasks(Date.now())).toBe(0); // untouched
    expect(live.state).toBe("executing");
  });

  it("a per-watch lease blocks only that watch's scan; other due watches still run", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    const leased = await createWatch({ name: "leased", protocol: "leased", sources: [{ type: "github_releases", target: "org/repo" }] });
    await createWatch({ name: "free", protocol: "free", sources: [{ type: "github_releases", target: "org/repo2" }] });
    setWatchDeps({
      fetchSource: async () => {
        throw new Error("all sources fail -> run fails fast, that is fine here");
      },
      sendTelegram: async () => {},
    } as never);
    // Another worker is already checking "leased":
    const { persistence } = await import("@/lib/storage");
    const leaseRelease = await persistence().acquireLease(`watch-run:${leased.id}`, 10 * 60_000);
    expect(leaseRelease).not.toBeNull();
    await runAutoScanOnce();
    const tasks = JSON.parse(readFileSync(path.join(dataDir, "tasks.json"), "utf8")) as Array<{ goal: string }>;
    // "free" ran; "leased" did not.
    expect(tasks.some((t) => t.goal.includes("free"))).toBe(true);
    expect(tasks.some((t) => t.goal.includes("leased"))).toBe(false);
    await leaseRelease!();
    // With the lease released, the very next tick checks it too.
    await runAutoScanOnce();
    const after = JSON.parse(readFileSync(path.join(dataDir, "tasks.json"), "utf8")) as Array<{ goal: string }>;
    expect(after.some((t) => t.goal.includes("leased"))).toBe(true);
  });

  it("a missed scheduled scan catches up: an old lastCheckedAt makes the watch due again", async () => {
    const { createWatch } = await import("@/lib/watch/store");
    setWatchDeps({
      fetchSource: async () => {
        throw new Error("down");
      },
      sendTelegram: async () => {},
    } as never);
    const w = await createWatch({ name: "catchup", protocol: "catchup", sources: [{ type: "github_releases", target: "org/repo" }] });
    expect(w.lastCheckedAt).toBeNull();
    await runAutoScanOnce(); // ran (and failed with all sources down; recorded)
    let tasks = JSON.parse(readFileSync(path.join(dataDir, "tasks.json"), "utf8")) as Array<{ goal: string }>;
    const runsAfterFirst = tasks.length;
    expect(runsAfterFirst).toBe(1);

    // Simulate a LONG outage (a dead worker for many intervals): rewind the
    // persisted lastCheckedAt far past the interval, then a single tick must
    // pick the watch back up - catch-up, not "wait for the next slot".
    const watchFile = path.join(dataDir, "watches.json");
    const watches = JSON.parse(readFileSync(watchFile, "utf8")) as Array<{ id: string; lastCheckedAt: number | null }>;
    const record = watches.find((x) => x.id === w.id)!;
    record.lastCheckedAt = Date.now() - 90 * 60_000;
    writeFileSync(watchFile, JSON.stringify(watches));
    const { resetWatchStore } = await import("@/lib/watch/store");
    resetWatchStore(); // in-memory caches must not hide the rewind

    await runAutoScanOnce();
    tasks = JSON.parse(readFileSync(path.join(dataDir, "tasks.json"), "utf8")) as Array<{ goal: string }>;
    expect(tasks.length).toBe(runsAfterFirst + 1); // the missed scan ran
  });

  it("pending alerts that failed delivery are retried by the scheduler tick automatically", async () => {
    const { createWatch, getWatch, mutateWatch } = await import("@/lib/watch/store");
    let failSend = true;
    setWatchDeps({
      fetchSource: async (source: { id: string; label: string }) => ({
        sourceId: source.id,
        sourceLabel: source.label,
        ok: true as const,
        snapshot: {
          signature: "release:v2.0.0",
          summary: `${source.label}: Release v2.0.0`,
          detail: `${source.label}: newest published release v2.0.0, a routine feature drop`,
        },
      }),
      sendTelegram: async () => {
        if (failSend) throw new Error("Telegram sendMessage failed: HTTP 503 service unavailable");
      },
    } as never);
    const watch = await createWatch({ name: "deliverlater", protocol: "deliverlater", sources: [{ type: "github_releases", target: "org/repo" }], telegramChatId: 1234 });
    await runAutoScanOnce(); // baseline: signature recorded, nothing to send
    // Force a REAL change on the next tick: the fetcher now serves v2.0.0;
    // rewind the fingerprint to v1.0.0 so the diff is genuine.
    await mutateWatch(watch.id, (w) => {
      for (const s of w.sources) w.fingerprints[s.id] = { signature: "release:v1.0.0", seenAt: Date.now() - 60_000 };
      w.lastCheckedAt = null;
    });
    await runAutoScanOnce(); // change detected -> alert recorded, delivery fails (503)
    const { listAlerts } = await import("@/lib/watch/alerts");
    let alerts = await listAlerts(watch.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("pending");
    expect(alerts[0].attempts).toBe(1);
    expect(alerts[0].lastError).toContain("503");

    // Age the failed attempt past its backoff (boundedly, minutes), exactly
    // what wall-clock time does between two ticks in production.
    const { persistence } = await import("@/lib/storage");
    const ledger = (await persistence().readNamed<Array<{ key: string; lastAttemptAt?: number }>>(`watch-alerts:${watch.id}`))!;
    for (const a of ledger) a.lastAttemptAt = Date.now() - 10 * 60_000;
    await persistence().writeNamed(`watch-alerts:${watch.id}`, ledger);

    // The next tick catches up WITHOUT a new change: same fetcher output,
    // fingerprints unchanged -> no re-detection, pure delivery recovery.
    failSend = false;
    await runAutoScanOnce();
    alerts = await listAlerts(watch.id);
    expect(alerts).toHaveLength(1); // no duplicate alert
    expect(alerts[0].status).toBe("delivered");
    expect(alerts[0].attempts).toBe(2);
    expect(await getWatch(watch.id)).not.toBeNull();
  });
});
