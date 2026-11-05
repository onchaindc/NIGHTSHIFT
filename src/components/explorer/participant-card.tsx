import Link from "next/link";

import type { NetworkMiner } from "@/lib/explorer/network";

function micro(usdc?: number) {
  return usdc === undefined ? undefined : `$${(usdc / 1_000_000).toFixed(2)}`;
}

export function ParticipantCard({ participant }: { participant: NetworkMiner }) {
  const price = micro(participant.min_price_usdc);
  const intents = participant.supported_intents ?? [];
  return (
    <Link
      href={`/miners/${participant.slug}`}
      className="group block rounded-lg border border-edge bg-panel p-5 transition-colors hover:border-edge-strong"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[14.5px] font-semibold text-ink">{participant.name}</h3>
          <p className="tabular mt-0.5 text-[11px] text-ink-faint">
            {participant.protocol} · {participant.slug}
          </p>
        </div>
        {price && <span className="tabular shrink-0 rounded bg-panel-3 px-2 py-1 text-[11.5px] font-medium text-teal">{price} min</span>}
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
    </Link>
  );
}

function friendly(s: string) {
  return s.toLowerCase().replaceAll(/_/g, " ");
}
