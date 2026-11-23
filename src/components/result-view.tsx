import type { ReactNode } from "react";

/**
 * One renderer for every miner answer, shared by the Terminal and Activity.
 *
 * Miners are free to return any JSON shape. The previous screens guessed at a
 * couple of shapes and fell back to dumping the raw payload when they missed,
 * which made an ordinary answer look like an error log. This keeps the raw
 * payload available in the callers' collapsed "Technical details", but always
 * puts a human-readable claim, papers, text or field list first.
 */

type FactCheck = {
  claim: string;
  verdict: string | null;
  reasoning: string | null;
  sources: string[];
};

type Paper = { title: string; doi?: string; venue?: string };

type RecordItem = { title: string; subtitle?: string; url?: string };

type PrimitiveField = { key: string; label: string; value: string | number | boolean };
type StringListField = { key: string; label: string; items: string[] };

const FACT_KEYS = new Set(["claim", "verdict", "reasoning", "explanation", "analysis"]);
const TEXT_KEYS = ["answer", "brief", "summary", "text", "content", "result"] as const;
const MAX_PAPERS = 12;
const MAX_SOURCES = 8;
const MAX_STRING = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

/** Plain text, or a JSON string the miner sent without an object wrapper. */
export function resultFromSummary(summary: string): unknown {
  const trimmed = summary.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return summary;
    }
  }
  return summary;
}

function normalize(value: unknown): unknown {
  return typeof value === "string" ? resultFromSummary(value) : value;
}

function factCheckOf(value: unknown): FactCheck | null {
  if (!isRecord(value)) return null;
  const claim = text(value.claim);
  if (!claim) return null;

  const rawVerdict = value.verdict;
  const verdict =
    typeof rawVerdict === "string" && rawVerdict.trim().length > 0
      ? rawVerdict.trim()
      : typeof rawVerdict === "boolean"
        ? rawVerdict
          ? "True"
          : "False"
        : null;
  const reasoning =
    text(value.reasoning) ?? text(value.explanation) ?? text(value.analysis) ?? null;
  const sources = [
    ...stringList(value.sources),
    ...stringList(value.source_urls),
    ...(text(value.source_url) ? [text(value.source_url) as string] : []),
  ];

  return { claim, verdict, reasoning, sources: [...new Set(sources)] };
}

function papersOf(value: unknown): { papers: Paper[]; total: number | null } | null {
  if (!isRecord(value)) return null;
  const papers: Paper[] = [];

  // Crossref works search: { message: { items: [{ title, DOI, container-title }] } }
  if (isRecord(value.message)) {
    const message = value.message;
    const items = Array.isArray(message.items) ? message.items : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const rawTitle = Array.isArray(item.title) ? item.title[0] : item.title;
      const title = text(rawTitle);
      if (!title) continue;
      const rawVenue = Array.isArray(item["container-title"])
        ? item["container-title"][0]
        : item["container-title"];
      papers.push({
        title,
        doi: text(item.DOI) ?? undefined,
        venue: text(rawVenue) ?? undefined,
      });
    }
    if (papers.length > 0) {
      const total = typeof message["total-results"] === "number" ? message["total-results"] : papers.length;
      return { papers, total };
    }
  }

  // Telegraph-shaped academic result: titles and DOIs in parallel arrays.
  const titles = stringList(value.paper_titles);
  if (titles.length === 0) return null;
  const dois = stringList(value.dois);
  return {
    papers: titles.map((title, index) => ({ title, doi: dois[index] })),
    total: typeof value.total_matches === "number" ? value.total_matches : null,
  };
}

function paragraphsOf(value: unknown): string[] {
  const split = (input: string) =>
    input
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

  if (typeof value === "string") return split(value);
  if (!isRecord(value)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (input: string) => {
    for (const paragraph of split(input)) {
      if (paragraph.length > 1 && !seen.has(paragraph)) {
        seen.add(paragraph);
        out.push(paragraph);
      }
    }
  };

  for (const key of TEXT_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string") push(candidate);
  }
  if (out.length === 0) {
    const longest = Object.values(value)
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 40)
      .sort((a, b) => b.length - a.length)[0];
    if (longest) push(longest);
  }
  return out;
}

function recordItemsOf(value: unknown): RecordItem[] {
  if (!Array.isArray(value)) return [];
  const items: RecordItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title =
      text(item.title) ??
      text(item.name) ??
      text(item.headline) ??
      text(item.label) ??
      text(item.id) ??
      null;
    if (!title) continue;
    const url = text(item.url) ?? text(item.link) ?? text(item.html_url) ?? undefined;
    const subtitle =
      text(item.description) ??
      text(item.summary) ??
      text(item.abstract) ??
      text(item.publisher) ??
      undefined;
    items.push({ title, subtitle, url });
  }
  return items;
}

function fieldLabel(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return spaced.length > 48 ? spaced.slice(0, 48) + "…" : spaced;
}

function summarizeValue(value: unknown): PrimitiveField["value"] | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const primitives = value.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    if (primitives.length === value.length && primitives.length > 0) {
      return primitives.map(String).join(", ").slice(0, MAX_STRING);
    }
    return `${value.length.toLocaleString()} item${value.length === 1 ? "" : "s"}`;
  }
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return `${count.toLocaleString()} field${count === 1 ? "" : "s"}`;
  }
  return null;
}

function fieldsOf(value: unknown): PrimitiveField[] {
  if (!isRecord(value)) return [];
  const fields: PrimitiveField[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (FACT_KEYS.has(key) || (TEXT_KEYS as readonly string[]).includes(key)) continue;
    if (raw == null) continue;
    const summary = summarizeValue(raw);
    if (summary == null) continue;
    fields.push({ key, label: fieldLabel(key), value: summary });
  }
  return fields;
}

function stringListFieldsOf(value: unknown): StringListField[] {
  if (!isRecord(value)) return [];
  const lists: StringListField[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const items = stringList(raw);
    if (items.length !== raw.length) continue;
    lists.push({ key, label: fieldLabel(key), items });
  }
  return lists;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function shortText(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING).trimEnd() + "…" : value;
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const lower = verdict.toLowerCase();
  const tone = /true|correct|supported|verified/.test(lower)
    ? "border-teal/40 bg-teal/5 text-teal"
    : /false|incorrect|fake|debunked|unsupported/.test(lower)
      ? "border-risk/40 bg-risk/5 text-risk"
      : "border-amber/40 bg-amber-soft text-amber-deep";
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${tone}`}>
      {verdict}
    </span>
  );
}

function FactCheckView({ fact }: { fact: FactCheck }) {
  const incomplete = fact.verdict == null;
  return (
    <div className={`rounded-xl border p-4 ${incomplete ? "border-amber/40 bg-amber-soft/40" : "border-edge bg-panel-2"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="x-label">FACT CHECK</p>
        {fact.verdict ? <VerdictBadge verdict={fact.verdict} /> : null}
      </div>
      <p className="mt-2 text-[15px] font-medium leading-relaxed text-ink">{fact.claim}</p>

      {incomplete ? (
        <div className="mt-3 rounded-lg border border-amber/30 bg-panel/60 px-3 py-2.5">
          <p className="text-[12.5px] font-medium text-amber-deep">No verdict returned</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
            {fact.reasoning
              ? "The answer service returned sources and reasoning but no verdict. That makes this result incomplete; use the sources below to judge the claim rather than treating it as confirmed."
              : "The answer service returned sources without a verdict or reasoning. That makes this result incomplete; use the sources below to judge the claim rather than treating it as confirmed."}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[13px] font-medium text-ink">
          Verdict: <span className="text-ink-soft">{fact.verdict}</span>
        </p>
      )}

      {fact.reasoning ? (
        <div className="mt-3">
          <p className="x-label">Why</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{shortText(fact.reasoning)}</p>
        </div>
      ) : null}

      {fact.sources.length > 0 ? (
        <div className="mt-3">
          <p className="x-label">Sources · {fact.sources.length}</p>
          <ul className="mt-2 space-y-1.5">
            {fact.sources.slice(0, MAX_SOURCES).map((source) => (
              <li key={source} className="min-w-0 text-[12px]">
                <a
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-teal underline decoration-teal/30 underline-offset-2 hover:decoration-teal"
                  title={source}
                >
                  <span className="font-medium">{sourceLabel(source)}</span>
                  <span className="ml-2 text-ink-faint">{source}</span>
                </a>
              </li>
            ))}
          </ul>
          {fact.sources.length > MAX_SOURCES ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink-soft">
                Show the other {fact.sources.length - MAX_SOURCES}
              </summary>
              <ul className="mt-1.5 space-y-1.5">
                {fact.sources.slice(MAX_SOURCES).map((source) => (
                  <li key={source} className="truncate text-[12px]">
                    <a href={source} target="_blank" rel="noreferrer" className="text-teal underline decoration-teal/30 underline-offset-2" title={source}>
                      {sourceLabel(source)} · {source}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PaperRow({ paper }: { paper: Paper }) {
  return (
    <li className="rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
      <p className="text-[13px] leading-snug text-ink">{paper.title}</p>
      {paper.venue ? <p className="mt-0.5 text-[11.5px] text-ink-faint">{paper.venue}</p> : null}
      {paper.doi ? (
        <a
          href={`https://doi.org/${paper.doi}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block text-[11.5px] text-teal underline decoration-teal/30 underline-offset-2"
        >
          {paper.doi}
        </a>
      ) : null}
    </li>
  );
}

function PapersView({ papers, total }: { papers: Paper[]; total: number | null }) {
  return (
    <div>
      {total != null ? (
        <p className="mb-2 text-[11.5px] text-ink-faint">
          {total.toLocaleString()} match{total === 1 ? "" : "es"} · showing {Math.min(papers.length, MAX_PAPERS)} of {papers.length}
        </p>
      ) : null}
      <ul className="space-y-2">
        {papers.slice(0, MAX_PAPERS).map((paper, index) => (
          <PaperRow key={`${paper.title}-${index}`} paper={paper} />
        ))}
      </ul>
      {papers.length > MAX_PAPERS ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11.5px] text-ink-faint hover:text-ink-soft">
            Show the other {papers.length - MAX_PAPERS}
          </summary>
          <ul className="mt-2 space-y-2">
            {papers.slice(MAX_PAPERS).map((paper, index) => (
              <PaperRow key={`${paper.title}-${index}`} paper={paper} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function FieldValue({ field }: { field: PrimitiveField }): ReactNode {
  if (typeof field.value === "boolean") {
    return <span className="text-ink">{field.value ? "Yes" : "No"}</span>;
  }
  if (typeof field.value === "number") {
    return <span className="tabular text-ink">{field.value.toLocaleString()}</span>;
  }
  const value = shortText(field.value);
  if (isHttpUrl(field.value)) {
    return (
      <a
        href={field.value}
        target="_blank"
        rel="noreferrer"
        className="break-all text-[12px] text-teal underline decoration-teal/30 underline-offset-2"
      >
        {value}
      </a>
    );
  }
  return <span className="whitespace-pre-wrap text-[12.5px] text-ink">{value}</span>;
}

function StringList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((item, index) => (
        <li
          key={`${item}-${index}`}
          className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-soft"
        >
          <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-edge-strong" />
          {isHttpUrl(item) ? (
            <a
              href={item}
              target="_blank"
              rel="noreferrer"
              title={item}
              className="min-w-0 break-words text-teal underline decoration-teal/30 underline-offset-2 hover:decoration-teal"
            >
              {sourceLabel(item)}
            </a>
          ) : (
            <span className="min-w-0">{shortText(item)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function GenericView({ value }: { value: unknown }) {
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="tabular text-[15px] leading-relaxed text-ink">{String(value)}</p>;
  }

  const paragraphs = paragraphsOf(value);
  const listFields: StringListField[] = Array.isArray(value)
    ? (() => {
        const items = stringList(value);
        return items.length === value.length && items.length > 0
          ? [{ key: "items", label: "Items", items }]
          : [];
      })()
    : stringListFieldsOf(value);
  const listKeys = new Set(listFields.map((field) => field.key));
  const paragraphValues = new Set(paragraphs.map((paragraph) => paragraph.trim()));
  const fields = fieldsOf(value).filter(
    (field) =>
      !listKeys.has(field.key) &&
      !(typeof field.value === "string" && paragraphValues.has(field.value.trim())),
  );

  // Arrays of records deserve their titles; a bare "4 items" hides the useful
  // part of news/search responses.
  const recordLists: Array<{ key: string; items: RecordItem[] }> = [];
  if (Array.isArray(value)) {
    const items = recordItemsOf(value);
    if (items.length > 0) recordLists.push({ key: "items", items });
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "sources" || key === "source_urls") continue;
      const items = recordItemsOf(child);
      if (items.length > 0) recordLists.push({ key, items });
    }
  }

  if (paragraphs.length === 0 && fields.length === 0 && listFields.length === 0 && recordLists.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-soft">
        The miner returned a structured result with no readable text fields. The full payload is in Technical details.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {paragraphs.length > 0 ? (
        <div className="space-y-2">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">
              {shortText(paragraph)}
            </p>
          ))}
        </div>
      ) : null}

      {fields.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-edge bg-panel-2 px-3.5 py-3 sm:grid-cols-[minmax(7rem,0.35fr)_1fr]">
          {fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{field.label}</dt>
              <dd className="min-w-0">
                <FieldValue field={field} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {listFields.map((list) => (
        <div key={list.key}>
          <p className="x-label">
            {list.label} · {list.items.length}
          </p>
          <StringList items={list.items.slice(0, 8)} />
          {list.items.length > 8 ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink-soft">
                Show the other {list.items.length - 8}
              </summary>
              <StringList items={list.items.slice(8)} />
            </details>
          ) : null}
        </div>
      ))}

      {recordLists.map((list) => (
        <div key={list.key}>
          <p className="x-label">{fieldLabel(list.key)} · {list.items.length}</p>
          <ul className="mt-2 space-y-2">
            {list.items.slice(0, 8).map((item, index) => (
              <li key={`${item.title}-${index}`} className="rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[13px] leading-snug text-teal underline decoration-teal/30 underline-offset-2 hover:decoration-teal"
                  >
                    {item.title}
                  </a>
                ) : (
                  <p className="text-[13px] leading-snug text-ink">{item.title}</p>
                )}
                {item.subtitle ? (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-faint">{item.subtitle}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {list.items.length > 8 ? (
            <p className="mt-1.5 text-[11px] text-ink-faint">
              +{list.items.length - 8} more in Technical details.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The readable result; callers keep the raw payload in collapsed Technical details. */
export function ResultView({ result }: { result: unknown }) {
  const value = normalize(result);
  const fact = factCheckOf(value);
  if (fact) return <FactCheckView fact={fact} />;

  const papers = papersOf(value);
  if (papers) {
    const brief = isRecord(value) ? text(value.brief) : null;
    return (
      <div className="space-y-3">
        {brief ? <p className="text-[14px] leading-relaxed text-ink">{brief}</p> : null}
        <PapersView papers={papers.papers} total={papers.total} />
      </div>
    );
  }

  return <GenericView value={value} />;
}
