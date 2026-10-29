import { createHash } from "node:crypto";
import { safeHttpGet } from "./ssrf";
import type { SourceFetchResult, SourceSnapshot, SourceType, WatchSource } from "./types";

/**
 * Real source fetchers. Every function performs an actual HTTP read of a
 * public, legitimate source and distills it into a comparable signature plus
 * a human summary. Nothing is cached secretly, nothing is fabricated: a
 * failed read produces a failed SourceFetchResult, never a made-up snapshot.
 */

export class SourceFetchError extends Error {}

const TIMEOUT_MS = 12_000;

/**
 * All source reads go through the SSRF guard: user-supplied targets are
 * scheme-checked, resolved to public addresses only, and each hop (including
 * redirects) is revalidated. A non-public target never leaves this module.
 */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const res = await safeHttpGet(url, {
    timeoutMs: TIMEOUT_MS,
    headers: process.env.GITHUB_TOKEN && url.includes("api.github.com")
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : undefined,
  });
  return { status: res.status, body: res.body };
}

function notOk(source: WatchSource, status: number, body: string): never {
  throw new SourceFetchError(`HTTP ${status} from ${source.target}${body ? ` (${body.slice(0, 140)})` : ""}`);
}

/** Pulls the first <title> out of an HTML page, if any. */
function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface FetchOut {
  snapshot: SourceSnapshot;
}

async function fetchGithubReleases(source: WatchSource, base: string): Promise<FetchOut> {
  const target = source.target.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  const { status, body } = await httpGet(`${base}/repos/${target}/releases?per_page=3`);
  if (status !== 200) notOk(source, status, body);
  let releases: Array<Record<string, unknown>>;
  try {
    releases = JSON.parse(body) as Array<Record<string, unknown>>;
  } catch {
    throw new SourceFetchError(`GitHub returned non-JSON for ${source.target}`);
  }
  if (!Array.isArray(releases)) throw new SourceFetchError(`Unexpected GitHub releases shape for ${source.target}`);
  const latest = releases[0];
  if (!latest) {
    return { snapshot: { signature: "no-releases", summary: "No published releases yet", detail: "The repository has no published releases. They will be reported when published.", url: `https://github.com/${target}/releases` } };
  }
  const tag = String(latest.tag_name ?? "");
  const publishedAt = latest.published_at ? String(latest.published_at) : "";
  const name = String(latest.name ?? tag);
  const notes = stripTags(String(latest.body ?? "")).slice(0, 400);
  // When the release name equals the tag (GitHub default), show it once, not
  // "tag (tag)".
  const title = name === tag ? tag : name === "" ? tag : `${name} (${tag})`;
  return {
    snapshot: {
      signature: `release:${tag}:${publishedAt}`,
      summary: latest.draft ? `${name} (draft)` : title,
      detail: latest.draft
        ? `Latest release on GitHub is the draft "${name}" (${tag}). Draft releases are visible to maintainers only; nothing is published yet.`
        : `Latest published release: ${title}${publishedAt ? `, published ${publishedAt}` : ""}.${notes ? ` Notes: ${notes}` : ""}`,
      url: `https://github.com/${target}/releases`,
    },
  };
}

async function fetchGithubCommits(source: WatchSource, base: string): Promise<FetchOut> {
  const target = source.target.replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  const { status, body } = await httpGet(`${base}/repos/${target}/commits?per_page=3`);
  if (status !== 200) notOk(source, status, body);
  const commits = JSON.parse(body) as Array<Record<string, unknown>>;
  if (!Array.isArray(commits)) throw new SourceFetchError(`Unexpected GitHub commits shape for ${source.target}`);
  const latest = commits[0];
  if (!latest) throw new SourceFetchError(`Repository ${target} has no commits`);
  const sha = String(latest.sha ?? "").slice(0, 12);
  const msg = String((latest.commit as { message?: string })?.message ?? "").split("\n")[0];
  const shortlog = commits.map((c) => String((c.commit as { message?: string })?.message ?? "").split("\n")[0]).join(" | ");
  return {
    snapshot: {
      signature: `commit:${sha}`,
      summary: sha ? `HEAD ${sha}` : "unknown",
      detail: `Newest commit ${sha}: "${msg}". Nearest newer-than-last: ${shortlog}`,
      url: `https://github.com/${target}/commits`,
    },
  };
}

async function fetchDocsUrl(source: WatchSource): Promise<FetchOut> {
  const { status, body } = await httpGet(source.target);
  if (status !== 200) notOk(source, status, body);
  // Hash the NORMALIZED visible text, not the raw HTML: served pages carry
  // per-request nonces, build ids and script payloads that change on every
  // fetch, which made raw-HTML hashing report false content changes.
  const text = stripTags(body);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const title = htmlTitle(body) ?? source.label;
  return {
    snapshot: {
      signature: `docs:${hash}`,
      summary: title,
      detail: `Documentation page "${title}" read successfully (content hash ${hash}). Any change to the served content changes this hash.`,
      url: source.target,
    },
  };
}

async function fetchDiscourseForum(source: WatchSource): Promise<FetchOut> {
  const base = source.target.replace(/\/+$/, "");
  const { status, body } = await httpGet(`${base}/latest.json`);
  if (status !== 200) notOk(source, status, body);
  const data = JSON.parse(body) as { topic_list?: { topics?: Array<Record<string, unknown>> } };
  const topics = data.topic_list?.topics ?? [];
  if (!Array.isArray(topics) || topics.length === 0) {
    return { snapshot: { signature: "no-topics", summary: "No topics listed", detail: "The forum returned no topics. New threads will be reported when they appear.", url: base } };
  }
  const ids = topics.slice(0, 5).map((t) => String(t.id));
  const titles = topics.slice(0, 5).map((t) => `${t.title ?? t.slug ?? t.id}`).join(" | ");
  const top = topics[0];
  return {
    snapshot: {
      signature: `topics:${ids.join(",")}`,
      summary: String(top.title ?? top.slug ?? "latest topic"),
      detail: `Latest forum activity (newest first): ${titles}.`,
      url: base,
    },
  };
}

async function fetchRssFeed(source: WatchSource): Promise<FetchOut> {
  const { status, body } = await httpGet(source.target);
  if (status !== 200) notOk(source, status, body);
  const entries = body.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/g) ?? [];
  if (entries.length > 0) {
    const first = entries[0] as string;
    const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(first)?.[1] ?? "untitled entry");
    const linkRaw = stripTags(/<link[^>]*>([\s\S]*?)<\/link>/i.exec(first)?.[1] ?? "");
    const linkAttr = /<link[^>]*href="([^"]+)"[^>]*\/>/i.exec(first)?.[1] ?? "";
    const link = linkRaw || linkAttr;
    const idTrue = stripTags(/<(?:guid|id)[^>]*>([\s\S]*?)<\/(?:guid|id)>/i.exec(first)?.[1] ?? "");
    const titles = entries.slice(0, 5).map((e) => stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(e)?.[1] ?? "")).filter(Boolean).join(" | ");
    return {
      snapshot: {
        signature: `feed:${createHash("sha256").update(idTrue || title).digest("hex").slice(0, 16)}`,
        summary: title,
        detail: `Newest feed entry: "${title}"${link ? ` (${link})` : ""}. Newest titles: ${titles}`,
        url: link || source.target,
      },
    };
  }
  // A well-formed feed that simply has nothing in it yet (e.g. a repository
  // with no published releases) is a valid baseline, not a failed read.
  if (!/<(?:feed|rss|rdf)[\s>]/.test(body)) throw new SourceFetchError(`No RSS/Atom entries found at ${source.target}`);
  return {
    snapshot: {
      signature: "no-entries",
      summary: "No entries published yet",
      detail: "The feed is valid but has no entries yet. They will be reported when they appear.",
      url: source.target,
    },
  };
}

const GITHUB_API = "https://api.github.com";

/**
 * Reads one configured source. Errors are returned, not thrown: a failed
 * source is honest data for the report, not a crash and never an invention.
 */
export async function fetchSource(source: WatchSource): Promise<SourceFetchResult> {
  const wrap = async (fn: () => Promise<FetchOut>): Promise<SourceFetchResult> => {
    try {
      const { snapshot } = await fn();
      return { sourceId: source.id, sourceLabel: source.label, ok: true, snapshot: { ...snapshot, url: snapshot.url ?? source.target } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { sourceId: source.id, sourceLabel: source.label, ok: false, error: message.includes("aborted") ? `timed out after 12s: ${source.target}` : message };
    }
  };

  switch (source.type) {
    case "github_releases":
      return wrap(() => fetchGithubReleases(source, GITHUB_API));
    case "github_commits":
      return wrap(() => fetchGithubCommits(source, GITHUB_API));
    case "docs_url":
      return wrap(() => fetchDocsUrl(source));
    case "discourse_forum":
      return wrap(() => fetchDiscourseForum(source));
    case "rss_feed":
      return wrap(() => fetchRssFeed(source));
    default: {
      const bad: SourceFetchResult = { sourceId: source.id, sourceLabel: source.label, ok: false, error: `unsupported source type` };
      return bad as SourceFetchResult;
    }
  }
}

/** Type guard so config validation actually checks the union. */
export function isSupportedType(t: string): t is SourceType {
  return ["github_releases", "github_commits", "docs_url", "discourse_forum", "rss_feed"].includes(t);
}
