import Link from "next/link";

import { fetchValidators } from "@/lib/explorer/network";

export const metadata = { title: "Validators" };
export const dynamic = "force-dynamic";

export default async function ValidatorsPage() {
  const fetched = await fetchValidators();

  if (fetched.status !== "ok") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · VALIDATORS</p>
        <h1 className="x-display-1 mt-4 text-ink">Validator registry unavailable</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The public validator registry could not be read: <span className="tabular text-[12px]">{fetched.detail}</span>{" "}
          Nothing is shown rather than a cached or invented list.
        </p>
        <Link href="/" className="btn-quiet mt-6 !min-h-9">
          Back to overview
        </Link>
      </div>
    );
  }

  if (fetched.payload.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <p className="x-tag">EXPLORER · VALIDATORS</p>
        <h1 className="x-display-1 mt-4 text-ink">No validators registered</h1>
        <p className="mt-4 max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">
          The registry is reachable and returned an empty validator set. That is the network's honest state at this
          moment, not a display error.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <p className="x-tag">EXPLORER · VALIDATORS · {fetched.payload.length} REGISTERED</p>
      <h1 className="x-display-1 mt-3 text-ink">Settlement and integrity</h1>
      <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-soft">
        Validators countersign paid-request outcomes: each one publishes its chain address, peer identity and activity
        counters, exactly as the public registry reports them. Nothing here is computed or ranked by the explorer — it
        is the registry, read directly.
      </p>

      <div className="mt-10 overflow-x-auto rounded-lg border border-edge">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead className="bg-panel-3">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-ink-faint">Moniker</th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-ink-faint">Chain address</th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium text-ink-faint">Peer identity</th>
              <th scope="col" className="tabular px-4 py-2.5 text-right font-medium text-ink-faint">Tokens mined</th>
              <th scope="col" className="tabular px-4 py-2.5 text-right font-medium text-ink-faint">Tx signed</th>
              <th scope="col" className="tabular px-4 py-2.5 text-right font-medium text-ink-faint">Tx submitted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge bg-panel">
            {fetched.payload.map((v) => (
              <tr key={v.address}>
                <td className="px-4 py-3 font-medium text-ink">{v.moniker}</td>
                <td className="tabular max-w-[220px] truncate px-4 py-3 text-ink-soft" title={v.address}>{v.address}</td>
                <td className="tabular max-w-[220px] truncate px-4 py-3 text-ink-soft" title={v.peer_id}>{v.peer_id}</td>
                <td className="tabular px-4 py-3 text-right text-ink">{v.tokensMined ?? "—"}</td>
                <td className="tabular px-4 py-3 text-right text-ink-soft">{v.transactionsSigned ?? "—"}</td>
                <td className="tabular px-4 py-3 text-right text-ink-soft">{v.transactionsSubmitted ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="x-tag mt-4">COUNTERS ARE THE REGISTRY'S OWN VALUES, REPORTED BY EACH VALIDATOR</p>
    </div>
  );
}
