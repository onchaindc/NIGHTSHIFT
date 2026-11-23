import { safeHttpGet } from "./ssrf";

/**
 * Repository Intelligence: a REAL technical investigation of a GitHub
 * repository, built from actual public reads — repository metadata, the file
 * structure, recent commits with their hashes and authors, published releases
 * and their notes, the dependency manifest (and lockfile when present), the
 * classified GitHub security advisories touching those exact dependency
 * versions, the repo's own published advisories, and the CI workflows.
 *
 * Honesty rules, same as every Protocol Watch executor:
 *  - A finding exists only when its evidence was actually fetched. Nothing is
 *    invented; generic advice is never dressed up as completed analysis.
 *  - A read that fails is recorded as an unexamined source (an unresolved
 *    question or a gap finding), never as a negative result.
 *  - "No changes detected" (a routine fingerprint check) and "investigation
 *    completed" (this module ran) are different outcomes and never conflated.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "informational";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

export type RepoFindingCategory =
  | "stack"
  | "activity"
  | "dependencies"
  | "security"
  | "api_changes"
  | "config_deployment"
  | "breaking_changes"
  | "releases";

export interface RepoFinding {
  id: string;
  category: RepoFindingCategory;
  severity: Severity;
  title: string;
  detail: string;
  /** Verbatim evidence facts this finding restates: hashes, versions, ids, urls. */
  evidence: string[];
  evidenceUrl?: string;
  whyItMatters: string;
  remediation: string;
}

export type RepoOutcome = "investigation_completed" | "no_changes_detected";

export interface RepoScopeItem {
  kind: string;
  detail: string;
  url: string;
  ok: boolean;
}

export interface RepoReport {
  repository: string; // owner/repo
  defaultBranch: string | null;
  outcome: RepoOutcome;
  examinedAt: number;
  /** Every source the investigation attempted, including failed reads. */
  scope: RepoScopeItem[];
  /** Concrete technologies observed in the repo's own files, with evidence. */
  stack: Array<{ name: string; evidence: string }>;
  /** Highest-severity first. */
  findings: RepoFinding[];
  /** Executive summary text. */
  summary: string;
  /** Sources that could not be read, and questions the data cannot answer. */
  unresolvedQuestions: string[];
}

/* ------------------------------------------------------------------ */
/* Fetch layer (injectable for tests; SSRF-guarded in production)      */
/* ------------------------------------------------------------------ */

export interface RepoIntelDeps {
  now: () => number;
  nextId: () => string;
  /** Performs a SSRF-guarded public read; throws on failure. Returns raw text. */
  httpGetText: (url: string) => Promise<string>;
}

async function defaultHttpGetText(url: string): Promise<string> {
  const res = await safeHttpGet(url, {
    timeoutMs: 12_000,
    headers:
      process.env.GITHUB_TOKEN && url.includes("api.github.com")
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : undefined,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.body;
}

export const repoIntelDeps: RepoIntelDeps = {
  now: () => Date.now(),
  nextId: () => Math.random().toString(36).slice(2, 10),
  httpGetText: defaultHttpGetText,
};

/** Test hook: replace the fetch layer, restore with resetRepoIntelDeps(). */
export function setRepoIntelDeps(overrides: Partial<RepoIntelDeps>): void {
  Object.assign(repoIntelDeps, overrides);
}
export function resetRepoIntelDeps(): void {
  repoIntelDeps.now = () => Date.now();
  repoIntelDeps.nextId = () => Math.random().toString(36).slice(2, 10);
  repoIntelDeps.httpGetText = defaultHttpGetText;
}

async function getJson(url: string): Promise<unknown> {
  return JSON.parse(await repoIntelDeps.httpGetText(url)) as unknown;
}

/* ------------------------------------------------------------------ */
/* Severity classification: transparent rules, stated as such          */
/* ------------------------------------------------------------------ */

/**
 * CVSS base-score bands (v3/v4): >=9.0 critical, >=7.0 high, >=4.0 medium,
 * >0 low. Used directly when a numeric score exists.
 */
export function cvssScoreToSeverity(score: number): Severity {
  if (!Number.isFinite(score) || score <= 0) return "informational";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

/**
 * Advisory severity word mapping (GitHub's published qualitative severity).
 * CRITICAL/HIGH/MEDIUM/MODERATE/LOW map 1:1; anything else degrades to MEDIUM
 * deliberately: an advisory with an unparseable rating is still a published
 * advisory about this exact dependency, so it keeps a conservative middle
 * rating with an explicit note instead of disappearing.
 */
export function advisoryWordToSeverity(word: string): { severity: Severity; note?: string } {
  const w = word.trim().toUpperCase();
  if (w === "CRITICAL") return { severity: "critical" };
  if (w === "HIGH") return { severity: "high" };
  if (w === "MEDIUM" || w === "MODERATE") return { severity: "medium" };
  if (w === "LOW") return { severity: "low" };
  return {
    severity: "medium",
    note: `rating "${word}" is not a standard severity word; classified conservatively as medium pending manual CVSS review`,
  };
}

/**
 * Breaking-change language in a release note or commit message, transparent
 * keyword rules: an explicit BREAKING CHANGE footer or a semantic marker
 * (feat!:, fix!:) means the maintainer says the surface changed.
 */
export function breakingLanguage(text: string): boolean {
  return /BREAKING CHANGE|feat!|fix!|refactor!|\bbreaking\b/i.test(text);
}

/* ------------------------------------------------------------------ */
/* Data shapes (only the fields we actually read)                       */
/* ------------------------------------------------------------------ */

interface RepoMeta {
  default_branch?: string;
  language?: string;
  description?: string;
  license?: { spdx_id?: string } | null;
  pushed_at?: string;
}

interface CommitRecord {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}

interface ReleaseRecord {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  prerelease?: boolean;
}

interface ContentRecord {
  name?: string;
  type?: string;
}

interface AdvisoryRecord {
  ghsa_id?: string;
  summary?: string;
  severity?: string;
  html_url?: string;
  vulns?: Array<{ patched_versions?: string }>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** package-lock.json v2/v3: "packages" keyed by path with a "version". */
interface Lockfile {
  packages?: Record<string, { version?: string }>;
}

/* ------------------------------------------------------------------ */
/* The investigation                                                    */
/* ------------------------------------------------------------------ */

const GH = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export interface InvestigateRepoInput {
  /** owner/repo, as in the watch sources. */
  repository: string;
}

class Scope {
  items: RepoScopeItem[] = [];
  hit(kind: string, detail: string, url: string): void {
    this.items.push({ kind, detail, url, ok: true });
  }
  miss(kind: string, detail: string, url: string, error: string): void {
    this.items.push({ kind, detail: `${detail} (unavailable: ${error})`, url, ok: false });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRepo(target: string): string {
  return target.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/i, "");
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 160);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Resolves runtime dependency versions out of package-lock.json v2/v3. */
function resolveLockVersions(lock: Lockfile, deps: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of deps) {
    const exact = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof exact === "string" && exact) out[name] = exact;
  }
  return out;
}

type StackMark = { name: string; evidence: string };

function detectStack(root: ContentRecord[], manifest: Manifest | null, workflows: number): StackMark[] {
  const marks: StackMark[] = [];
  const names = root.map((e) => e.name ?? "");
  if (names.includes("package.json")) marks.push({ name: "Node.js / npm workspace", evidence: "package.json at repository root" });
  if (names.includes("next.config.ts") || names.includes("next.config.mjs") || names.includes("next.config.js"))
    marks.push({ name: "Next.js", evidence: root.find((n) => /^next\.config\./.test(n?.name ?? ""))?.name ?? "next config file" });
  if (manifest && /"@?hardhat|truffle|foundry|ethers|viem/.test(JSON.stringify(manifest)))
    marks.push({ name: "Ethereum toolchain", evidence: "EVM package references in package.json (hardhat/foundry/ethers/viem)" });
  if (workflows > 0) marks.push({ name: "GitHub Actions CI", evidence: `${workflows} workflow file(s) in .github/workflows` });
  if (names.includes("Dockerfile")) marks.push({ name: "Container deployment", evidence: "Dockerfile at repository root" });
  if (names.includes("vercel.json") || names.includes("vercel")) marks.push({ name: "Vercel deployment", evidence: names.includes("vercel.json") ? "vercel.json at root" : "vercel directory at root" });
  return marks;
}

/**
 * Runs the full technical investigation. Throws only when the repository
 * itself cannot be read at all (every attempted read failed) — a partial
 * investigation always completes with the gaps recorded honestly as scope
 * misses and unresolved questions.
 */
export async function investigateRepository(input: InvestigateRepoInput): Promise<RepoReport> {
  const repo = normalizeRepo(input.repository);
  const scope = new Scope();
  const repository = `${GH}/repos/${repo}`;

  /* --- repo meta (mandatory: without it nothing else can be addressed) - */
  let meta: RepoMeta;
  try {
    meta = (await getJson(repository)) as RepoMeta;
    scope.hit("repository_metadata", `GitHub repository metadata (primary language ${meta.language ?? "unknown"}${meta.license?.spdx_id ? `, license ${meta.license.spdx_id}` : ""})`, repository);
  } catch (err) {
    scope.miss("repository_metadata", "GitHub repository metadata", repository, messageOf(err));
    throw new Error(`the repository itself could not be read (${messageOf(err)}), so no honest investigation is possible`);
  }
  const defaultBranch = typeof meta.default_branch === "string" ? meta.default_branch : null;

  /* --- structure ------------------------------------------------------ */
  let root: ContentRecord[] = [];
  try {
    root = ((await getJson(`${repository}/contents`)) as ContentRecord[]) ?? [];
    scope.hit("file_structure", `Root directory listing: ${root.filter((e) => e.type === "file").length} file(s), ${root.filter((e) => e.type === "dir").length} director(y/ies)`, `${repository}/contents`);
  } catch (err) {
    scope.miss("file_structure", "Root directory listing", `${repository}/contents`, messageOf(err));
  }

  /* --- recent commits -------------------------------------------------- */
  let commits: CommitRecord[] = [];
  try {
    commits = ((await getJson(`${repository}/commits?per_page=20`)) as CommitRecord[]) ?? [];
    scope.hit("recent_commits", `${commits.length} latest commit(s) with hashes, authors and message subjects`, `${repository}/commits?per_page=20`);
  } catch (err) {
    scope.miss("recent_commits", "Recent commits", `${repository}/commits?per_page=20`, messageOf(err));
  }

  /* --- releases --------------------------------------------------------- */
  let releases: ReleaseRecord[] = [];
  try {
    releases = ((await getJson(`${repository}/releases?per_page=10`)) as ReleaseRecord[]) ?? [];
    scope.hit("releases", `${releases.length} most recent release(s) with published notes`, `${repository}/releases?per_page=10`);
  } catch (err) {
    scope.miss("releases", "Published releases", `${repository}/releases?per_page=10`, messageOf(err));
  }

  /* --- dependency manifest + lockfile ------------------------------------ */
  let manifest: Manifest | null = null;
  const manifestUrl = `${RAW}/${repo}/${defaultBranch}/package.json`;
  if (root.some((e) => e.name === "package.json") || defaultBranch) {
    try {
      manifest = (await getJson(manifestUrl)) as Manifest;
      const counts = `${Object.keys(manifest?.dependencies ?? {}).length} runtime / ${Object.keys(manifest?.devDependencies ?? {}).length} dev dependencies`;
      scope.hit("dependency_manifest", `package.json parses (${counts})`, manifestUrl);
    } catch (err) {
      scope.miss("dependency_manifest", "package.json dependency manifest", manifestUrl, messageOf(err));
      manifest = null;
    }
  }
  const runtimeDeps = Object.entries(manifest?.dependencies ?? {});
  const devDeps = Object.entries(manifest?.devDependencies ?? {});
  let resolvedVersions: Record<string, string> = {};
  let lockError: string | null = null;
  if (manifest) {
    const lockUrl = `${RAW}/${repo}/${defaultBranch}/package-lock.json`;
    try {
      const lock = JSON.parse(await repoIntelDeps.httpGetText(lockUrl)) as Lockfile;
      resolvedVersions = resolveLockVersions(lock, runtimeDeps.map(([n]) => n));
      scope.hit("lockfile", `package-lock.json parses; ${Object.keys(resolvedVersions).length} runtime dependency version(s) pinned to an exact installable version`, lockUrl);
    } catch (err) {
      lockError = messageOf(err);
      scope.miss("lockfile", "package-lock.json (exact installed versions)", lockUrl, lockError);
    }
  }

  /* --- the repo's own published advisories -------------------------------- */
  let repoAdvisories: AdvisoryRecord[] = [];
  try {
    repoAdvisories = ((await getJson(`${repository}/security-advisories?per_page=10`)) as AdvisoryRecord[]) ?? [];
    scope.hit("repository_advisories", `${repoAdvisories.length} published security advisory/advisories for this repository itself`, `${repository}/security-advisories?per_page=10`);
  } catch (err) {
    scope.miss("repository_advisories", "Published repository advisories", `${repository}/security-advisories?per_page=10`, messageOf(err));
  }

  /* --- CI workflows -------------------------------------------------------- */
  const workflowRisks: RepoFinding[] = [];
  let workflowFiles = 0;
  try {
    const list = ((await getJson(`${repository}/contents/.github/workflows`)) as ContentRecord[]) ?? [];
    workflowFiles = list.length;
    scope.hit("ci_workflows", `${list.length} CI workflow file(s) in .github/workflows`, `${repository}/contents/.github/workflows`);
    for (const wf of list.slice(0, 8)) {
      const name = wf.name ?? "";
      if (!/\.(yml|yaml)$/.test(name)) continue;
      const url = `${RAW}/${repo}/${defaultBranch}/.github/workflows/${name}`;
      try {
        const content = await repoIntelDeps.httpGetText(url);
        scope.hit("ci_workflow", `Read CI workflow "${name}" (${content.split("\n").length} lines)`, url);
        /* Unpinned third-party action: a floating tag resolves to the action
         * repo's HEAD at run time, so a compromise of that action defaults
         * THIS repo's workflow to the attacker's code too. Pinned SHAs make
         * the supply chain auditable. */
        if (/uses:\s*\S+@\S+/.test(content) && !/uses:\s*\S+@[0-9a-f]{40}/.test(content)) {
          workflowRisks.push({
            id: repoIntelDeps.nextId(),
            category: "config_deployment",
            severity: "medium",
            title: `CI/CD workflow "${name}" references reusable actions by floating tags, not pinned commit SHAs`,
            detail: `${name} contains at least one "uses: <action>@<tag>" reference that does not resolve to a fixed commit SHA, so the executed action code can change under the repo without any commit here.`,
            evidence: [`workflow ${name} contains an unpinned action reference`],
            evidenceUrl: url,
            whyItMatters: "CI is the strongest trust grain in a repository: every deploy credential and release key flows through it unpinned.",
            remediation: "Pin every reusable action to a full 40-character commit SHA and keep pins fresh with Dependabot's scheduled sha-remediation.",
          });
        }
        /* pull_request_target + PR-head checkout: the job runs with the
         * repo's own secrets while executing fork-controlled code. */
        if (/pull_request_target/.test(content) && /pull.*\/head/.test(content)) {
          workflowRisks.push({
            id: repoIntelDeps.nextId(),
            category: "config_deployment",
            severity: "high",
            title: `CI/CD workflow "${name}" runs attacker-controlled code against repository secrets`,
            detail: `${name} triggers on pull_request_target AND checks out the PR's head ref; combined with secrets available in the job, a hostile PR can run its own code with deploy credentials.`,
            evidence: [`workflow ${name}: pull_request_target + PR head checkout in the same job`],
            evidenceUrl: url,
            whyItMatters: "This is the classic compromised-PR pipeline: one crafted pull request away from a full repository takeover.",
            remediation: "Split untrusted-code builds (pull_request, no secrets) from authenticated deploy jobs, or gate pull_request_target behind maintainer approval.",
          });
        }
      } catch (err) {
        scope.miss("ci_workflow", `CI workflow "${name}"`, url, messageOf(err));
      }
    }
  } catch (err) {
    scope.miss("ci_workflows", ".github/workflows listing", `${repository}/contents/.github/workflows`, messageOf(err));
  }

  /* --- findings ------------------------------------------------------------- */
  const findings: RepoFinding[] = [];

  /* 1. the repository's OWN published advisories */
  for (const a of repoAdvisories) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "security",
      severity: advisoryWordToSeverity(a.severity ?? "unknown").severity,
      title: `Published security advisory for this repository: ${a.summary ?? a.ghsa_id ?? "untitled"}`,
      detail: `A published advisory (id ${a.ghsa_id ?? "unknown"}) names ${repo} itself as affected; rating recorded as "${a.severity ?? "unknown"}".`,
      evidence: [a.ghsa_id ?? "id unknown", `rating ${a.severity ?? "unknown"}`, a.vulns?.[0]?.patched_versions ? `patched in ${a.vulns[0].patched_versions}` : "no patched version recorded"],
      evidenceUrl: a.html_url,
      whyItMatters: "This repo is itself an integration target; a published advisory is the maintainer's official word about a known weakness in it.",
      remediation: `Read the advisory (${a.html_url ?? "link recorded in the detail"}) and apply the called-out patch or mitigation before relying on this repo's affected versions.`,
    });
  }

  /* 2. breaking-change and unstable-release language, straight from the notes */
  for (const rel of releases.filter((r) => (r.body ?? "").length > 0 || r.prerelease)) {
    const breaking = breakingLanguage(rel.body ?? "");
    const pre = rel.prerelease === true;
    if (!breaking && !pre) continue;
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "breaking_changes",
      severity: breaking ? "high" : "medium",
      title: `Release ${rel.tag_name ?? rel.name ?? "untitled"} ${breaking ? "carries breaking-change language" : "is not marked stable (prerelease)"}`,
      detail: squash((rel.body ?? "no published note").slice(0, 600)),
      evidence: [rel.tag_name ?? rel.name ?? "untitled release", breaking ? "release notes contain BREAKING CHANGE / feat! / breaking markers" : "release is flagged prerelease", rel.published_at ? `published ${rel.published_at}` : "publication date unknown"],
      evidenceUrl: rel.html_url,
      whyItMatters: breaking
        ? "A declared breaking change can silently break every consumer of this repo's API or configuration surface on the next pull."
        : "Consumers tracking a default channel can land on unstable code; behavior is not contractually stable until the stable tag follows.",
      remediation: breaking
        ? "Read the release notes end to end and schedule an integration test against the new surface before any upgrade."
        : "Stay on the current stable tag until the prerelease behavior is absorbed by tests or released stable.",
    });
  }
  if (releases.length > 0 && !releases.some((r) => breakingLanguage(r.body ?? ""))) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "releases",
      severity: "informational",
      title: `No breaking-change language in ${releases.length} recent release(s)`,
      detail: `The ${releases.length} most recent releases carry no BREAKING CHANGE / feat! / fix! markers; latest ${releases[0].tag_name ?? releases[0].name ?? "(untitled)"}.`,
      evidence: releases.slice(0, 5).map((r) => `${r.tag_name ?? r.name ?? "untitled"}${r.published_at ? ` (${r.published_at})` : ""}`),
      whyItMatters: "An absence of declared breaking changes in recent releases constrains the upgrade risk surface a consumer faces.",
      remediation: "No action required on this evidence; re-check whenever a new release publishes notes.",
    });
  } else if (releases.length === 0) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "releases",
      severity: "informational",
      title: "No published releases",
      detail: "The repository has no published GitHub releases; consumers derive their version from commit ranges, which is weaker provenance.",
      evidence: ["/releases returned zero published release objects"],
      whyItMatters: "Without releases there is no signed, announced version boundary to pin against.",
      remediation: "For consumers: record the consumed commit SHA explicitly; for maintainers: start tagging releases with notes.",
    });
  }

  /* 3. recent activity + security-relevant commit messages */
  const realCommits = commits.filter((c) => typeof c.sha === "string" && c.commit);
  if (realCommits.length > 0) {
    const last = realCommits[0];
    const authors = Array.from(new Set(realCommits.map((c) => c.author?.login ?? c.commit!.author?.name ?? "unknown").slice(0, 20)));
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "activity",
      severity: "informational",
      title: `Recent activity: ${realCommits.length} latest commit(s), ${authors.length} author(s)`,
      detail: `Latest commit ${last.sha!.slice(0, 10)} by ${last.author?.login ?? last.commit!.author?.name ?? "unknown"}: ${firstLine(last.commit!.message ?? "")}`,
      evidence: realCommits.slice(0, 8).map((c) => `${c.sha!.slice(0, 10)} ${firstLine(c.commit!.message ?? "")}${c.author?.login ? ` (${c.author.login})` : ""}`),
      evidenceUrl: `https://github.com/${repo}/commits`,
      whyItMatters: "Recent commits are where regressions first appear; a short author list concentrates review risk on few maintainers.",
      remediation: "Re-read this list whenever a release lands; correlate anything security-worded with the advisory channels before upgrading.",
    });
    for (const c of realCommits.slice(0, 40)) {
      const msg = c.commit!.message ?? "";
      if (/security|vulnerab|exploit|\bcve\b|advisory|critical/i.test(msg)) {
        findings.push({
          id: repoIntelDeps.nextId(),
          category: "security",
          severity: /critical|exploit|\bcve\b/i.test(msg) ? "high" : "medium",
          title: `Security-relevant commit in recent history: ${firstLine(msg).slice(0, 120)}`,
          detail: `Commit ${c.sha!.slice(0, 10)} on the default branch carries security-relevant language in its own message.`,
          evidence: [`${c.sha!.slice(0, 10)} ${firstLine(msg)}`, c.author?.login ? `authored by ${c.author.login}` : ""].filter(Boolean),
          evidenceUrl: `https://github.com/${repo}/commit/${c.sha}`,
          whyItMatters: "A security word in a maintainer's own commit message is the repo speaking about a weakness; it is evidence, not noise.",
          remediation: `Open the commit (${`https://github.com/${repo}/commit/${c.sha}`}) and confirm whether it mitigates or introduces the issue it describes; plan the corresponding upgrade or backport.`,
        });
      }
    }
  }

  /* 4. dependency advisories, per exact installed version when resolvable */
  for (const [name] of runtimeDeps) {
    const version = resolvedVersions[name];
    const range = version ?? "*";
    const query = `${name}@${range}`;
    const url = `${GH}/advisories?affects=${encodeURIComponent(query)}&ecosystem=npm&per_page=10`;
    try {
      const advisories = ((await getJson(url)) as AdvisoryRecord[]) ?? [];
      scope.hit("dependency_advisories", `${advisories.length} advisory/affect-query result(s) for ${query}`, url);
      for (const a of advisories) {
        const { severity, note } = advisoryWordToSeverity(a.severity ?? "unknown");
        findings.push({
          id: repoIntelDeps.nextId(),
          category: "dependencies",
          severity,
          title: `Dependency advisory: ${name}${version ? `@${version}` : ""} — ${a.summary ?? a.ghsa_id ?? "untitled"}`,
          detail: [
            a.summary ?? "",
            a.ghsa_id ? `Advisory id ${a.ghsa_id}.` : "",
            note ?? "",
            version
              ? `This advisory was matched against the exact installed version ${name}@${version}, so the weakness is likely present as-is.`
              : `Installed version unresolved (${lockError ?? "no readable lockfile"}); the advisory names ANY known affected version of ${name}, which cannot be ruled in or out without a manual check.`,
          ].filter(Boolean).join(" "),
          evidence: [
            a.ghsa_id ?? "id unknown",
            `rating ${a.severity ?? "unknown"}`,
            a.vulns?.[0]?.patched_versions ? `patched in ${a.vulns[0].patched_versions}` : "no patched version recorded",
            version ? `installed ${version}` : "installed version unresolved",
          ],
          evidenceUrl: a.html_url,
          whyItMatters: version
            ? "The advisory targets this exact dependency version, so the affected code path ships as written."
            : "Without a resolvable installed version the advisory's affected range is open-ended and the risk is unbounded until reviewed.",
          remediation: `Read the advisory and the package changelog; upgrade ${name} to the first version that patches ${a.ghsa_id ?? "the advisory"} and re-commit the lockfile.`,
        });
      }
    } catch (err) {
      scope.miss("dependency_advisories", `Advisory query for ${query}`, url, messageOf(err));
    }
  }

  /* 5. manifest + lockfile hygiene gaps */
  if (manifest && runtimeDeps.length === 0) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "dependencies",
      severity: "low",
      title: "package.json lists no runtime dependencies",
      detail: 'The manifest declares no "dependencies" entries. That can be accurate for a library or a workspace root, or can mean dependencies are consumed without being declared.',
      evidence: ["package.json parsed successfully", "no non-empty dependencies key"],
      evidenceUrl: manifestUrl,
      whyItMatters: "An empty runtime dependency set makes the advisory pass structurally silent; undeclared real dependencies would be missed entirely.",
      remediation: "Confirm by hand that the build pipeline installs nothing the manifest does not declare.",
    });
  }
  if (manifest && runtimeDeps.length > 0 && lockError) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "dependencies",
      severity: "low",
      title: "No readable package-lock.json: exact dependency versions unresolved",
      detail: `package.json declares ${runtimeDeps.length} direct runtime dependencies, but the lockfile could not be read (${lockError}); advisories were matched per package range rather than per exact installed version.`,
      evidence: runtimeDeps.slice(0, 10).map(([n, v]) => `${n} declared ${v} (installed version unresolved)`),
      evidenceUrl: manifestUrl,
      whyItMatters: "Without exact versions, every advisory check degrades from a proof to a per-package alert, and clean-vs-affected cannot be distinguished.",
      remediation: "Commit a lockfile so installs are deterministic and advisory matching is exact.",
    });
  }

  /* 6. CI workflow risks, then structure/deployment observations */
  findings.push(...workflowRisks);
  const stack = detectStack(root, manifest, workflowFiles);
  if (root.some((e) => e.name === "Dockerfile")) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "config_deployment",
      severity: "informational",
      title: "Repository ships a Dockerfile",
      detail: "A Dockerfile exists at the repository root, so container configuration is a deployment surface for this integration.",
      evidence: ["root listing contains Dockerfile"],
      whyItMatters: "Container images reproduce whatever is in them: a stale base image or a root-only build become silent deployment risks.",
      remediation: "Review base-tag freshness and least-privilege settings whenever a release lands.",
    });
  }

  /* 7. stack observation (informational, evidence-backed) */
  if (stack.length > 0) {
    findings.push({
      id: repoIntelDeps.nextId(),
      category: "stack",
      severity: "informational",
      title: `Stack observed: ${stack.map((s) => s.name).join(", ")}`,
      detail: `Detected from the repository's own files: ${stack.map((s) => `${s.name} (${s.evidence})`).join("; ")}.`,
      evidence: stack.map((s) => `${s.name}: ${s.evidence}`),
      whyItMatters: "The stack decides where integration risk lives: runtimes, package managers and CI are the surfaces that actually execute.",
      remediation: "Treat each observed runtime as its own patch and advisory channel.",
    });
  }

  /* --- unresolved questions, straight from the missed reads ----------------- */
  const unresolvedQuestions = scope.items.filter((i) => !i.ok).map((i) => `${i.kind}: ${i.detail}`);
  if (realCommits.length === 0) unresolvedQuestions.push("recent_commits: no commit data was readable, so recent-change risk could not be assessed");
  if (!manifest) unresolvedQuestions.push("dependency_manifest: no manifest was readable, so the runtime dependency set and its advisories could not be enumerated");
  if (realCommits.length > 0 && authorsOf(realCommits).length <= 2) {
    unresolvedQuestions.push("activity: essentially all recent commits come from one or two authors; bus-factor and review-coverage risk is unassessed (needs deeper history)");
  }

  /* --- severity order: highest first ----------------------------------------- */
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.category.localeCompare(b.category));

  const outcome: RepoOutcome = "investigation_completed";
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const summary =
    findings.length === 0
      ? `Investigation of ${repo} completed against ${scope.items.filter((i) => i.ok).length}/${scope.items.length} planned source reads. No material findings: no published repository advisories, no breaking-change markers in recent releases, no dependency advisory matches within the reads that succeeded, and no CI misconfiguration patterns in the workflows actually fetched. This is a completed investigation, not a no-change check.`
      : `Investigation of ${repo} against ${scope.items.filter((i) => i.ok).length}/${scope.items.length} planned source reads produced ${findings.length} finding(s): ${criticalCount} critical, ${highCount} high. ${topLine(findings)}`;

  return {
    repository: repo,
    defaultBranch,
    outcome,
    examinedAt: repoIntelDeps.now(),
    scope: scope.items,
    stack,
    findings,
    summary,
    unresolvedQuestions,
  };
}

function authorsOf(commits: CommitRecord[]): string[] {
  return Array.from(new Set(commits.map((c) => c.author?.login ?? c.commit?.author?.name ?? "unknown")));
}

function topLine(findings: RepoFinding[]): string {
  const worst = findings[0];
  if (!worst) return "";
  return `Highest: [${worst.severity.toUpperCase()}] ${worst.title}`;
}
