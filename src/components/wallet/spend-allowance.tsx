"use client";

/**
 * The spending controls readout, fed by GET /api/spend/standing — the same
 * endpoint the paid-run gates enforce against. It shows the rolling-24h
 * allowance this wallet has spent of its cap and where it went, per Mind.
 * Nothing is invented: anonymous callers see the cap model itself, a failed
 * read says so.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

interface Standing {
  signedIn?: boolean;
  operator?: boolean;
  spentCents: number;
  capCents: number | null;
  remainingCents: number | null;
  perMind: Array<{ mind: string; spentCents: number }>;
  windowHours: number;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function SpendAllowance() {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/spend/standing", { cache: "no-store" });
      if (!res.ok) {
        setFailed(true);
      } else {
        setStanding((await res.json()) as Standing);
        setFailed(false);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const poll = setInterval(() => void reload(), 30_000);
    return () => clearInterval(poll);
  }, [reload]);

  return (
    <div className="rounded-2xl border border-edge bg-panel px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="x-label !mt-0">DAILY ALLOWANCE · PAYER-FUNDED RUNS</p>
        {standing?.windowHours ? (
          <span className="text-[11px] text-ink-faint">rolling {standing.windowHours}h window</span>
        ) : null}
      </div>

      {loading && standing === null && (
        <div aria-live="polite" className="mt-3">
          <div className="h-10 rounded-lg bg-panel-2 motion-safe:animate-pulse" />
          <p className="pt-2 text-[12px] text-ink-faint">Reading the spend standing…</p>
        </div>
      )}

      {failed && !loading && (
        <div className="mt-3" role="alert">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            The spend standing could not be read just now. The enforcement gates still apply — this panel only
            displays them.
          </p>
          <button type="button" onClick={() => void reload()} className="btn-quiet mt-3 !min-h-8 !text-[12px]">
            <RefreshCw size={12} aria-hidden /> Retry
          </button>
        </div>
      )}

      {standing && !failed && (
        <>
          {standing.operator ? (
            <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
              Operator session: payer-funded spend is aggregated and uncapped by design — the operator{" "}
              <em className="font-medium not-italic text-ink">is</em> the payer.{" "}
              <span className="tabular font-semibold text-ink">{usd(standing.spentCents)}</span> moved in the last{" "}
              {standing.windowHours}h.
            </p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="tabular text-[22px] font-semibold leading-none text-ink">
                  {usd(standing.spentCents)}
                </p>
                <p className="text-[12.5px] text-ink-soft">
                  {standing.capCents !== null ? (
                    <>
                      of the <span className="tabular">{usd(standing.capCents)}</span> daily allowance
                      {standing.signedIn ? "" : " once you sign in"}
                    </>
                  ) : (
                    "spent in the window"
                  )}
                </p>
              </div>
              {standing.capCents !== null && standing.capCents > 0 && (
                <div
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-panel-2"
                  role="img"
                  aria-label={`${usd(standing.spentCents)} of ${usd(standing.capCents)} spent`}
                >
                  <div
                    className="h-full rounded-full bg-teal transition-[width] duration-500"
                    style={{ width: `${Math.min(100, Math.round((standing.spentCents / standing.capCents) * 100))}%` }}
                  />
                </div>
              )}
              {standing.remainingCents !== null && (
                <p className="mt-2 text-[11.5px] text-ink-faint">
                  <span className="tabular">{usd(standing.remainingCents)}</span> still available before paid runs
                  stop for this wallet. Free modes stay open regardless.
                </p>
              )}
            </>
          )}

          {standing.perMind.length > 0 && (
            <ul className="mt-4 border-t border-edge pt-3">
              {standing.perMind.slice(0, 6).map((row) => (
                <li key={row.mind} className="flex items-baseline justify-between gap-3 py-1">
                  <span className="min-w-0 truncate text-[12px] text-ink-soft">{row.mind}</span>
                  <span className="tabular shrink-0 text-[12px] text-ink">{usd(row.spentCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
