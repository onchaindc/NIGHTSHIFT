import Link from "next/link";

import type { NetworkMiner } from "@/lib/explorer/network";

function micro(usdc?: number) {
  return usdc === undefined ? undefined : `$${(usdc / 1_000_000).toFixed(2)}`;
}

function shortDate(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ParticipantCard({ participant, showDates = false }: { participant: NetworkMiner; showDates?: boolean }) {
  const price = micro(participant.min_price_usdc);
  const intents = participant.supported_intents ?? [];
  return (
    <Link
      href={`/miners/${participant.slug}`}
      className="group block min-w-0 rounded-xl border border-edge bg-panel p-5 transition-all duration-200 hover:border-edge-strong hover:shadow-[0_6px_18px_-12px_rgba(22,24,29,0.35)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Two lines instead of a hard ellipsis: long registry names stay readable
              without reinstating the nowrap that widened the column. */}
          <h3 className="line-clamp-2 text-[14.5px] font-semibold leading-snug text-ink transition-colors group-hover:text-teal">
            {participant.name}
          </h3>
          <p className="tabular mt-0.5 text-[11px] text-ink-faint">
            {participant.protocol} · {participant.slug}
          </p>
        </div>
        {price && (
          <span className="tabular shrink-0 rounded-md border border-teal/20 bg-teal/5 px-2 py-1 text-[11.5px] font-medium text-teal">
            {price} min
          </span>
        )}
      </div>
      {participant.description && (
        <p className="mt-2.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-soft">{participant.description}</p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="truncate text-[11px] text-ink-faint">
          {intents.slice(0, 3).map(friendly).join(" · ")}
          {intents.length > 3 && ` +${intents.length - 3}`}
        </p>
        {typeof participant.total_requests_served === "number" && (
          <p className="tabular shrink-0 text-[11px] text-ink-faint">{participant.total_requests_served.toLocaleString()} served</p>
        )}
      </div>
      {showDates && (participant.registered_at || participant.last_scored_at) && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-edge/60 pt-2 text-[10.5px] text-ink-faint">
          {participant.registered_at && <span>Registered {shortDate(participant.registered_at)}</span>}
          {participant.last_scored_at && <span>Last scored {shortDate(participant.last_scored_at)}</span>}
        </p>
      )}
    </Link>
  );
}

function friendly(s: string) {
  return s.toLowerCase().replaceAll(/_/g, " ");
}
