"use client";

import { useEffect, useState } from "react";

/**
 * Budget dashboard strip: makes the per-user daily spend allowance visible on
 * the Minds catalogue. Data: GET /api/spend/standing (session-aware).
 * Rendered inline with the catalogue header — one compact card, no separate
 * page to visit.
 */

interface Standing {
  signedIn: boolean;
  operator?: boolean;
  spentCents: number;
  capCents: number | null;
  remainingCents: number | null;
  perMind: Array<{ mind: string; spentCents: number }>;
}

const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function BudgetStrip() {
  const [standing, setStanding] = useState<Standing | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/spend/standing", { signal: AbortSignal.timeout(15_000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (alive && body) setStanding(body as Standing);
      })
      .catch(() => {
        /* the strip is additive; absence just renders nothing */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!standing) return null;
  const pct = standing.capCents ? Math.min(100, Math.round((standing.spentCents / standing.capCents) * 100)) : 0;
  const top = standing.perMind.slice(0, 3).map((m) => `${m.mind} ${fmt(m.spentCents)}`).join(" · ");

  return (
    <div className="rounded-xl border border-edge bg-panel px-4 py-3">
      {standing.signedIn && !standing.operator ? (
        <>
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12.5px] text-ink">
            <span>
              Paid spend, last 24h: <strong className="tabular">{fmt(standing.spentCents)}</strong> of the {fmt(standing.capCents ?? 0)} daily cap
            </span>
            <span className="text-[11px] text-ink-faint">
              {standing.remainingCents === 0
                ? "cap reached — paid runs park at the approval gate until the window rolls"
                : `${fmt(standing.remainingCents ?? 0)} still available today`}
            </span>
          </p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Daily paid-spend allowance used"
          >
            <div
              className={`h-full rounded-full ${pct >= 100 ? "bg-risk" : pct >= 70 ? "bg-amber" : "bg-teal"}`}
              style={{ width: `${Math.max(pct, standing.spentCents > 0 ? 3 : 0)}%` }}
            />
          </div>
          {top && <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">Top: {top}</p>}
        </>
      ) : standing.operator ? (
        <p className="text-[12.5px] text-ink">
          Payer-funded spend across all users, last 24h: <strong className="tabular">{fmt(standing.spentCents)}</strong>
          {top ? <span className="text-ink-soft"> · {top}</span> : null}
          <span className="block text-[11px] text-ink-faint">The operator funds the payer wallet, so this aggregate is uncapped by design.</span>
        </p>
      ) : (
        <p className="text-[12.5px] text-ink-soft">
          Free probes are open to everyone. Paid runs draw from a per-user daily allowance ({fmt(standing.capCents ?? 0)}/day by default) — sign in to see yours.
        </p>
      )}
    </div>
  );
}
