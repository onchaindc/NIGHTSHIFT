"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@/lib/engine/types";
import { SOURCE_TYPE_LABELS, type SourceType, type WatchConfig } from "@/lib/watch/types";
import { StatusChip, isTestRun, money, timeOf } from "@/components/taskParts";

/**
 * Protocol Watch view: configure a protocol's legitimate public sources, run
 * real checks now (free, or with a bounded paid investigation), and see every
 * recorded run with its findings, costs, and delivery status. Data comes from
 * the real watch store and task store. The scheduler note is honest about the
 * monitoring pausing whenever the server process stops.
 */

const SOURCE_OPTIONS: Array<{ value: SourceType; hint: string; placeholder: string }> = [
  { value: "github_releases", hint: "reports the newest published release", placeholder: "owner/repo" },
  { value: "github_commits", hint: "reports the newest commit", placeholder: "owner/repo" },
  { value: "docs_url", hint: "content hash of a docs page, any change is a change", placeholder: "https://docs.example.com/protocol/" },
  { value: "discourse_forum", hint: "latest forum topics via the Discourse JSON API", placeholder: "https://forum.example.com" },
  { value: "rss_feed", hint: "newest entry of an RSS/Atom security feed", placeholder: "https://feed.example.com/security.xml" },
];

interface SourceDraft {
  type: SourceType;
  label: string;
  target: string;
}

/* ------------------------------------------------------------------ */
/* Create / configure                                                  */
/* ------------------------------------------------------------------ */

function CreateWatch({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("");
  const [sources, setSources] = useState<SourceDraft[]>([
    { type: "github_releases", label: "", target: "" },
  ]);
  const [limit, setLimit] = useState("1.00");
  const [approval, setApproval] = useState(true);
  const [chat, setChat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSource = (i: number, patch: Partial<SourceDraft>) =>
    setSources((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  async function create() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          protocol,
          sources: sources.filter((s) => s.target.trim()),
          spendLimitUsdCents: Math.round(Number(limit || "1") * 100) || undefined,
          requiresApprovalForPaid: approval,
          telegramChatId: chat.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Creating the watch failed with status ${res.status}.`);
      } else {
        setName("");
        setProtocol("");
        setSources([{ type: "github_releases", label: "", target: "" }]);
        setLimit("1.00");
        setApproval(true);
        setChat("");
        setOpen(false);
        onCreated();
      }
    } catch (err) {
      setError(`Could not reach the server. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-10 rounded-md border border-teal/40 bg-teal/15 px-4 py-2 text-[13px] font-medium text-teal transition-colors hover:bg-teal/25"
      >
        New watch
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-[14px] font-semibold">Configure a watch</h2>
        <p className="mt-0.5 text-[11.5px] text-ink-faint">
          Sources are read for what they actually publish. Nothing is fetched and nothing is spent at save time.
        </p>
      </div>
      <div className="px-4 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wname" className="mb-1.5 block text-xs font-medium text-ink-soft">Watch name</label>
            <input
              id="wname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Uniswap v4 core"
              className="min-h-10 w-full rounded-md border border-edge bg-panel-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="wprotocol" className="mb-1.5 block text-xs font-medium text-ink-soft">Protocol</label>
            <input
              id="wprotocol"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              placeholder="e.g. Uniswap"
              className="min-h-10 w-full rounded-md border border-edge bg-panel-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none"
            />
          </div>
        </div>

        <p className="x-label mb-2 mt-4">Sources (up to 5)</p>
        <div className="space-y-2">
          {sources.map((s, i) => {
            const opt = SOURCE_OPTIONS.find((o) => o.value === s.type)!;
            return (
              <div key={i} className="grid gap-2 rounded-md border border-edge bg-panel-2 p-2.5 sm:grid-cols-[150px_minmax(0,1fr)_110px_auto]">
                <select
                  aria-label={`Source ${i + 1} type`}
                  value={s.type}
                  onChange={(e) => setSource(i, { type: e.target.value as SourceType })}
                  className="min-h-10 rounded-sm border border-edge bg-panel px-2 text-[12.5px] text-ink focus:border-blue/60 focus:outline-none"
                >
                  {SOURCE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{SOURCE_TYPE_LABELS[o.value]}</option>
                  ))}
                </select>
                <input
                  aria-label={`Source ${i + 1} target`}
                  value={s.target}
                  onChange={(e) => setSource(i, { target: e.target.value })}
                  placeholder={opt.placeholder}
                  className="min-h-10 w-full rounded-sm border border-edge bg-panel px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none"
                />
                <input
                  aria-label={`Source ${i + 1} label (optional)`}
                  value={s.label}
                  onChange={(e) => setSource(i, { label: e.target.value })}
                  placeholder={opt.hint}
                  className="hidden min-h-10 rounded-sm border border-edge bg-panel px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none sm:block"
                />
                <button
                  type="button"
                  onClick={() => setSources((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={sources.length <= 1}
                  className="min-h-10 rounded-sm border border-edge px-3 text-[12px] text-ink-faint transition-colors hover:border-risk/50 hover:text-risk disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setSources((prev) => (prev.length < 5 ? [...prev, { type: "rss_feed", label: "", target: "" }] : prev))}
          disabled={sources.length >= 5}
          className="mt-2 min-h-9 rounded-sm border border-edge px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-blue/50 hover:text-ink disabled:opacity-40"
        >
          + Add source
        </button>

        <div className="x-rule my-4" />

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="wlimit" className="mb-1.5 block text-xs font-medium text-ink-soft">Investigation ceiling per run</label>
            <div className="flex min-h-10 items-baseline rounded-md border border-edge bg-panel-2 px-3 py-2">
              <span className="tabular text-[13px] text-ink-faint">$</span>
              <input
                id="wlimit"
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                className="w-20 bg-transparent pl-1 tabular text-sm text-ink focus:outline-none"
              />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-soft">Paid investigation approval</p>
            <button
              type="button"
              role="switch"
              aria-checked={approval}
              onClick={() => setApproval((v) => !v)}
              className={`flex min-h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-left transition-colors ${
                approval ? "border-gold/60 bg-gold/10" : "border-edge bg-panel-2 hover:border-edge-strong"
              }`}
            >
              <span className={`text-[12.5px] ${approval ? "text-gold" : "text-ink-soft"}`}>
                {approval ? "Ask me before paid steps" : "Allow paid steps directly"}
              </span>
              <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${approval ? "bg-gold" : "bg-edge-strong"}`} aria-hidden>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-night transition-all ${approval ? "left-3.5" : "left-0.5"}`} />
              </span>
            </button>
          </div>
          <div>
            <label htmlFor="wchat" className="mb-1.5 block text-xs font-medium text-ink-soft">Telegram chat id (optional)</label>
            <input
              id="wchat"
              value={chat}
              onChange={(e) => setChat(e.target.value.replace(/[^0-9-]/g, ""))}
              placeholder="e.g. 123456789"
              className="min-h-10 w-full rounded-md border border-edge bg-panel-2 px-3 py-2 tabular text-sm text-ink placeholder:text-ink-faint focus:border-blue/60 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-ink-faint">Messages come from @nightshiftagent_bot. Leave empty to keep reports in the Command Center only.</p>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-md border border-risk/40 bg-risk/5 px-3.5 py-2.5 text-[13px] text-risk">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-md border border-edge px-4 py-2 text-[13px] text-ink-soft hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={submitting || !name.trim() || !protocol.trim()}
            className="min-h-10 rounded-md border border-teal/40 bg-teal/15 px-5 py-2 text-[13px] font-medium text-teal transition-colors hover:bg-teal/25 disabled:opacity-40"
          >
            {submitting ? "Saving…" : "Create watch"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Watch list row                                                      */
/* ------------------------------------------------------------------ */

function WatchRow({
  watch,
  onRun,
  onDelete,
  busy,
  runError,
}: {
  watch: WatchConfig;
  onRun: (id: string, investigate: boolean) => void;
  onDelete: (id: string) => void;
  busy: string | null;
  runError: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article className="rounded-lg border border-edge bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-edge px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-ink">{watch.name}</span>
          <span className="rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[10.5px] text-ink-faint">{watch.protocol}</span>
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-teal/40 bg-teal/10 px-2 py-0.5 text-[10.5px] font-medium text-teal">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />
            {watch.sources.length} source{watch.sources.length === 1 ? "" : "s"}
          </span>
        </div>
        <span className="tabular text-[11px] text-ink-faint">
          {watch.lastCheckedAt ? `Last check ${timeOf(watch.lastCheckedAt)}` : "Never checked"}
        </span>
      </div>
      <div className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {watch.sources.map((s) => (
            <span key={s.id} className="rounded-sm border border-edge bg-panel-2 px-2 py-0.5 text-[11px] text-ink-soft">
              {SOURCE_TYPE_LABELS[s.type]}: {s.label.slice(0, 40)}
            </span>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onRun(watch.id, false)}
            disabled={busy === watch.id}
            className="min-h-9 rounded-md border border-edge bg-panel-2 px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:border-blue/50 disabled:opacity-50"
          >
            {busy === watch.id ? "Checking…" : "Check now (free)"}
          </button>
          <button
            type="button"
            onClick={() => onRun(watch.id, true)}
            disabled={busy === watch.id}
            title={`Adds a bounded Telegraph insight, at most ${money(watch.spendLimitUsdCents)}${watch.requiresApprovalForPaid ? ", approval required before it runs" : ""}`}
            className="min-h-9 rounded-md border border-teal/40 bg-teal/10 px-3.5 py-1.5 text-[12.5px] font-medium text-teal transition-colors hover:bg-teal/20 disabled:opacity-50"
          >
            Check + investigate (max {money(watch.spendLimitUsdCents)}{watch.requiresApprovalForPaid ? ", approval first" : ""})
          </button>
          {confirming ? (
            <>
              <button type="button" onClick={() => onDelete(watch.id)} className="min-h-9 rounded-md border border-risk/50 px-3 py-1.5 text-[12.5px] text-risk">
                Confirm delete
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="min-h-9 rounded-md px-2 py-1.5 text-[12px] text-ink-faint hover:text-ink">
                Keep
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="ml-auto min-h-9 rounded-md px-2.5 py-1.5 text-[12px] text-ink-faint transition-colors hover:text-risk">
              Delete
            </button>
          )}
          <Link href="/history" className="text-[11.5px] text-ink-faint hover:text-ink">
            Runs are recorded in history →
          </Link>
        </div>
        {runError && (
          <p role="alert" className="mt-2.5 rounded-md border border-risk/40 bg-risk/5 px-3 py-2 text-[12.5px] text-risk">
            {runError}
          </p>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Watch() {
  const [watches, setWatches] = useState<WatchConfig[] | null>(null);
  const [watchesFailed, setWatchesFailed] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [intervalLabel, setIntervalLabel] = useState<string>("10 minutes");
  const reload = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [w, t, s] = await Promise.all([
        fetch("/api/watches", { cache: "no-store" }),
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/status", { cache: "no-store" }),
      ]);
      if (w.ok) {
        setWatches(((await w.json()) as { watches: WatchConfig[] }).watches);
        setWatchesFailed(false);
      } else {
        setWatchesFailed(true);
      }
      if (t.ok) setTasks(((await t.json()) as { tasks: TaskRecord[] }).tasks);
      if (s.ok) {
        const body = (await s.json()) as { watchScheduler?: { intervalMs?: number } };
        const ms = body.watchScheduler?.intervalMs;
        if (ms && ms >= 30000) setIntervalLabel(ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`);
      }
    } catch {
      setWatchesFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, reload.current]);

  async function runCheck(id: string, investigate: boolean) {
    if (busy) return;
    setBusy(id);
    setRunErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/watches/${id}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investigate }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; task?: TaskRecord };
      if (!res.ok) {
        setRunErrors((prev) => ({ ...prev, [id]: body.error ?? `status ${res.status}` }));
      } else if (body.task && body.task.state === "awaiting_approval") {
        setRunErrors((prev) => ({ ...prev, [id]: `Plan built and waiting for your approval before the paid step. Approve it in the ${"Approvals"} view (task ${body.task!.id.slice(0, 8)}).` }));
      } else if (body.task && body.task.state === "failed") {
        setRunErrors((prev) => ({ ...prev, [id]: `Check failed: ${body.task!.error ?? "unknown error"}. Open the run for the full timeline.` }));
      }
    } catch (err) {
      setRunErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function removeWatch(id: string) {
    try {
      const res = await fetch(`/api/watches/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRunErrors((prev) => ({ ...prev, [id]: body.error ?? `status ${res.status}` }));
      }
    } catch (err) {
      setRunErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      void refresh();
    }
  }

  const watchRuns = (tasks ?? [])
    .filter((t) => t.jobType === "protocol_watch" && !isTestRun(t))
    .slice(0, 8);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-[22px] font-semibold tracking-tight">Protocol Watch</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
            Monitor a protocol's public sources, detect real changes, investigate what matters, and get a verified
            report. Free checks are always safe; investigation costs only what you allow.
          </p>
        </div>
        <CreateWatch onCreated={() => void refresh()} />
      </div>

      <p className="mt-4 rounded-md border border-edge bg-panel-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        Automatic checks run every {intervalLabel} while the server is running, and they are always free (they read
        sources and update fingerprints; they never pay anything). When this server stops, monitoring pauses with it:
        the list shows when each source was last really checked, and a restart resumes without repeating old changes.
      </p>

      {watchesFailed && (
        <p aria-live="assertive" role="alert" className="mt-4 rounded-md border border-risk/40 bg-risk/5 px-4 py-3 text-[13px] text-risk">
          Could not load the watch list. Retry by reloading once the server is reachable.
        </p>
      )}

      {watches === null && !watchesFailed && (
        <p aria-live="polite" className="mt-6 text-[13px] text-ink-faint">Loading watches…</p>
      )}

      {watches !== null && watches.length === 0 && !watchesFailed && (
        <div className="mt-5 rounded-lg border border-dashed border-edge bg-panel/50 px-5 py-8 text-center">
          <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
            No watches yet. Create one with a protocol and its sources; the first check records the baseline and later
            checks report real changes only.
          </p>
        </div>
      )}

      {watches !== null && watches.length > 0 && (
        <div className="mt-5 space-y-3">
          {watches.map((w) => (
            <WatchRow
              key={w.id}
              watch={w}
              onRun={runCheck}
              onDelete={removeWatch}
              busy={busy}
              runError={runErrors[w.id] ?? null}
            />
          ))}
        </div>
      )}

      {/* Recorded runs */}
      <section className="mt-9" aria-label="Recent watch runs">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Recent runs</h2>
          <span className="tabular text-[11px] text-ink-faint">real checks from the task store</span>
        </div>
        {tasks === null ? (
          <p aria-live="polite" className="text-[13px] text-ink-faint">Loading runs…</p>
        ) : watchRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-edge bg-panel/50 px-5 py-8 text-center">
            <p className="mx-auto max-w-sm text-[13px] text-ink-soft">
              No recorded runs yet. Check now (free) records a real run with its sources, findings, and delivery status.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-edge bg-panel">
            <table className="hidden w-full text-left md:table">
              <thead>
                <tr className="border-b border-edge text-[10.5px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Watch</th>
                  <th className="px-4 py-2.5 font-medium">Trigger</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {watchRuns.map((t) => (
                  <tr key={t.id} className="border-b border-edge/60 last:border-0 hover:bg-panel-2/60">
                    <td className="px-4 py-2.5"><StatusChip state={t.state} /></td>
                    <td className="max-w-[40ch] truncate px-4 py-2.5 text-[12.5px]">
                      <Link href={`/tasks/${t.id}`} className="text-ink transition-colors hover:text-teal">{t.goal.replace(/^Protocol Watch check: /, "")}</Link>
                    </td>
                    <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-faint">{t.watch?.triggeredBy ?? "manual"}</td>
                    <td className="px-4 py-2.5 text-right tabular text-[11.5px] text-ink-soft">{money(t.spend.spentUsdCents)}</td>
                    <td className="px-4 py-2.5 tabular text-[11.5px] text-ink-faint">{timeOf(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-edge md:hidden">
              {watchRuns.map((t) => (
                <li key={t.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <StatusChip state={t.state} />
                    <span className="tabular text-[11px] text-ink-faint">{timeOf(t.createdAt)}</span>
                  </div>
                  <Link href={`/tasks/${t.id}`} className="mt-1 block text-[12.5px] text-ink">{t.goal.replace(/^Protocol Watch check: /, "")}</Link>
                  <p className="mt-0.5 tabular text-[11px] text-ink-faint">{t.watch?.triggeredBy ?? "manual"} · {money(t.spend.spentUsdCents)}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
