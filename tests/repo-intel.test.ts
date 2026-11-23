import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advisoryWordToSeverity,
  breakingLanguage,
  cvssScoreToSeverity,
  investigateRepository,
  resetRepoIntelDeps,
  setRepoIntelDeps,
  SEVERITY_ORDER,
  type RepoReport,
} from "@/lib/watch/repo-intel";
import { resetStore } from "@/lib/engine/store";
import { resetWatchStore } from "@/lib/watch/store";
import { planWatchSteps, resetWatchDeps, setWatchDeps } from "@/lib/watch/execute";
import type { WatchConfig, WatchSource } from "@/lib/watch/types";

/* ------------------------------------------------------------------ */
/* Fixtures: a scripted, URL-routed fake GitHub                         */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  resetStore();
  resetWatchStore();
  resetWatchDeps();
  resetRepoIntelDeps();
});

function githubFixture(opts: {
  manifestBody?: string | null;
  lockBody?: string | null;
  releases?: unknown;
  advisoriesFor?: (url: string) => unknown[];
  workflowBodies?: string[];
}) {
  const REPO = "https://api.github.com/repos/owner/repo";
  const RAW = "https://raw.githubusercontent.com/owner/repo/main";
  const urlsRequested: string[] = [];
  const routes: Record<string, unknown> = {
    [`${REPO}`]: { default_branch: "main", language: "TypeScript", license: { spdx_id: "MIT" }, pushed_at: "2026-01-01T00:00:00Z" },
    [`${REPO}/contents`]: [{ name: "package.json", type: "file" }, { name: "Dockerfile", type: "file" }, { name: ".github", type: "dir" }],
    [`${REPO}/commits?per_page=20`]: [
      {
        sha: "a".repeat(40),
        author: { login: "dev1" },
        commit: { message: "fix!: change withdraw signature", author: { name: "Dev One" } },
      },
      {
        sha: "b".repeat(40),
        author: { login: "dev2" },
        commit: { message: "fix CVE-2026-1234 in dependency scanner", author: { name: "Dev Two" } },
      },
    ],
    [`${REPO}/releases?per_page=10`]: opts.releases ?? [
      { tag_name: "v2.0.0", name: "v2.0.0", prerelease: false, published_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/owner/repo/releases/tag/v2.0.0", body: "Major overhaul. BREAKING CHANGE: withdraw() now takes a recipient argument." },
    ],
    [`${REPO}/security-advisories?per_page=10`]: [
      { ghsa_id: "GHSA-crit-1111", severity: "critical", summary: "Funds can be drained", html_url: "https://github.com/owner/repo/security/advisories/GHSA-crit-1111" },
      { ghsa_id: "GHSA-????-2222", severity: "field unknown", summary: "Unclear rating advisory", html_url: "https://github.com/owner/repo/security/advisories/2" },
    ],
    [`${REPO}/contents/.github/workflows`]: [
      { name: "ci.yml", type: "file" },
      { name: "deploy.yml", type: "file" },
    ],
    [`${RAW}/.github/workflows/ci.yml`]: `name: ci\non: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n`,
    [`${RAW}/.github/workflows/deploy.yml`]: `on: pull_request_target\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n      - run: git fetch origin pull/pr/head && git checkout pr\n      - uses: ./internal-act\n`,
  };
  if (opts.manifestBody !== null) {
    routes[`${RAW}/package.json`] = opts.manifestBody ?? JSON.stringify({ dependencies: { scanner: "^1.0.0", leftpad: "^1.2.3" } });
  }
  if (opts.lockBody !== null) {
    routes[`${RAW}/package-lock.json`] = opts.lockBody ?? JSON.stringify({ packages: { "node_modules/leftpad": { version: "1.2.3" }, "node_modules/scanner": { version: "9.9.9" } } });
  }
  setRepoIntelDeps({
    nextId: () => `id-${urlsRequested.length}`,
    httpGetText: async (url) => {
      urlsRequested.push(url);
      const value = routes[url];
      if (value === undefined || value === null) throw new Error(`HTTP 404 from ${new URL(url).host}`);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  });
  return { urlsRequested, routes, REPO, RAW };
}

describe("repository intelligence: severity classification", () => {
  it("maps CVSS bands exactly as documented", () => {
    expect(cvssScoreToSeverity(0)).toBe("informational");
    expect(cvssScoreToSeverity(-5)).toBe("informational");
    expect(cvssScoreToSeverity(1.5)).toBe("low");
    expect(cvssScoreToSeverity(4.0)).toBe("medium");
    expect(cvssScoreToSeverity(7.0)).toBe("high");
    expect(cvssScoreToSeverity(9.0)).toBe("critical");
  });

  it("unknown advisory rating words degrade to medium WITH an explicit note", () => {
    const unknown = advisoryWordToSeverity("weird rating");
    expect(unknown.severity).toBe("medium");
    expect(unknown.note).toContain("not a standard severity word");
    expect(advisoryWordToSeverity("MODERATE").severity).toBe("medium");
    expect(advisoryWordToSeverity("CRITICAL").severity).toBe("critical");
    expect(advisoryWordToSeverity("HIGH").severity).toBe("high");
    expect(advisoryWordToSeverity("LOW").severity).toBe("low");
  });

  it("severity order puts critical first and SEVERITY_ORDER covers all severities", () => {
    expect(SEVERITY_ORDER.critical).toBeLessThan(SEVERITY_ORDER.high);
    expect(SEVERITY_ORDER.informational).toBeGreaterThan(SEVERITY_ORDER.low);
  });

  it("breaking language is matched by maintainer-declared markers, not vibes", () => {
    expect(breakingLanguage("BREAKING CHANGE: the swap path reorganized")).toBe(true);
    expect(breakingLanguage("feat!: move the withdraw")).toBe(true);
    expect(breakingLanguage("breaking: the withdraw")).toBe(true);
    expect(breakingLanguage("chore: tidy docs")).toBe(false);
    expect(breakingLanguage("")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Investigation: real reads, real gaps, no fabrication                  */
/* ------------------------------------------------------------------ */

describe("repository intelligence: investigation runs", () => {
  it("attributes every finding to fetched evidence and links its source", async () => {
    const fixture = githubFixture({});
    const report = await investigateRepository({ repository: "owner/repo" });
    expect(report.outcome).toBe("investigation_completed");
    expect(report.defaultBranch).toBe("main");
    // Advisory queries go AFTER the exact installed version (resolved via the lockfile).
    expect(fixture.urlsRequested).toContain(`https://api.github.com/advisories?affects=${encodeURIComponent("leftpad@1.2.3")}&ecosystem=npm&per_page=10`);
    for (const f of report.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      if (f.evidenceUrl) expect(f.evidenceUrl.startsWith("http")).toBe(true);
    }
    // Repo's own advisories with an unknown rating keep medium severity + note in detail.
    const unclear = report.findings.find((f) => f.title.includes("Unclear rating advisory"));
    expect(unclear?.severity).toBe("medium");
    expect(unclear?.detail).toContain("rating");
  });

  it("reports breaking-change releases and repo advisories from the actual data", async () => {
    githubFixture({});
    const report = await investigateRepository({ repository: "owner/repo" });
    const breaking = report.findings.find((f) => f.category === "breaking_changes");
    expect(breaking).toBeDefined();
    expect(breaking?.title).toContain("breaking-change language");
    const repoAdvisory = report.findings.find((f) => f.title.includes("Funds can be drained"));
    expect(repoAdvisory?.severity).toBe("critical");
    expect(report.findings[0].severity).toBe("critical"); // ordered highest first
  });

  it("captures CI risks: floating action tags and pull_request_target", async () => {
    githubFixture({});
    const report = await investigateRepository({ repository: "owner/repo" });
    const unpinned = report.findings.find((f) => f.title.includes("floating tags"));
    expect(unpinned).toBeDefined();
    expect(unpinned?.category).toBe("config_deployment");
    const prTarget = report.findings.find((f) => f.title.includes("attacker-controlled code"));
    expect(prTarget?.severity).toBe("high");
  });

  it("flags security-relevant commit language found in real commit messages", async () => {
    githubFixture({});
    const report = await investigateRepository({ repository: "owner/repo" });
    const cve = report.findings.find((f) => f.evidence.some((e) => e.includes("CVE-2026-1234")));
    expect(cve?.category).toBe("security");
    expect(cve?.title).toContain("CVE-2026-1234");
    expect(cve?.evidenceUrl).toContain("/commit/");
  });

  it("when even the repository metadata is unreadable it refuses loudly, never guesses", async () => {
    setRepoIntelDeps({
      nextId: () => "id",
      httpGetText: async () => {
        throw new Error("HTTP 404 from api.github.com");
      },
    });
    await expect(investigateRepository({ repository: "owner/repo" })).rejects.toThrow(/repository itself could not be read/);
  });

  it("records failed reads honestly as unresolved questions, never negatives", async () => {
    const REPO = "https://api.github.com/repos/owner/repo";
    const RAW = "https://raw.githubusercontent.com/owner/repo/main";
    setRepoIntelDeps({
      nextId: () => "id",
      httpGetText: async (url) => {
        if (url === `${REPO}/releases?per_page=10`) throw new Error("HTTP 500 from api.github.com");
        if (url === `${RAW}/package.json`) throw new Error("HTTP 404 from raw.githubusercontent.com");
        if (url === REPO) return JSON.stringify({ default_branch: "main", language: "TypeScript" });
        return JSON.stringify(url.includes("contents") ? [{ name: "README.md", type: "file" }] : url.includes("commits") ? [] : []);
      },
    });
    const report = await investigateRepository({ repository: "owner/repo" });
    expect(report.outcome).toBe("investigation_completed");
    expect(report.unresolvedQuestions.length).toBeGreaterThan(0);
    const releasesScope = report.scope.find((s) => s.kind === "releases");
    expect(releasesScope?.ok).toBe(false);
    const manifestScope = report.scope.find((s) => s.kind === "dependency_manifest");
    expect(manifestScope?.ok).toBe(false);
    // A missing manifest is named as an unexamined question, never as a negative.
    expect(report.unresolvedQuestions.join(" ")).toMatch(/dependency_manifest/);
  });

  it("does not query ALL unbounded versions when a lockfile exists (exact matched)", async () => {
    const fixture = githubFixture({});
    await investigateRepository({ repository: "owner/repo" });
    const advisoryUrls = fixture.urlsRequested.filter((u) => u.includes("/advisories?"));
    expect(advisoryUrls).toHaveLength(2); // two declared runtime deps
    expect(advisoryUrls.some((u) => decodeURIComponent(u).includes("affects=scanner@9.9.9"))).toBe(true); // resolved via lockfile
  });
});

describe("repository intelligence: watch plan wiring", () => {
  function src(t: WatchSource["type"], target: string): WatchSource {
    return { id: `sid-${t}-${target}`, type: t, target, label: t };
  }
  const githubWatch: WatchConfig = {
    id: "w1",
    name: "Repo watch",
    protocol: "Example",
    sources: [src("github_releases", "owner/repo")],
    spendLimitUsdCents: 0,
    requiresApprovalForPaid: false,
    telegramChatId: null,
    createdAt: 0,
    lastSnapshot: {},
  } as unknown as WatchConfig;

  const rssWatch: WatchConfig = {
    ...githubWatch,
    id: "w2",
    sources: [src("rss_feed", "https://example.com/feed.xml")],
  } as unknown as WatchConfig;

  it("adds the free 0-cost repo investigation step only for github watches", () => {
    const withRepo = planWatchSteps(githubWatch, true);
    expect(withRepo.map((s) => s.kind)).toContain("watch_repo_investigate");
    const step = withRepo.find((s) => s.kind === "watch_repo_investigate");
    expect(step?.maxCostUsdCents).toBe(0);
    const without = planWatchSteps(rssWatch, true);
    expect(without.map((s) => s.kind)).not.toContain("watch_repo_investigate");
  });
});
