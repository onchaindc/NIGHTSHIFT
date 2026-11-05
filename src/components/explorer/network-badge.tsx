export function NetworkBadge({ live }: { live: boolean }) {
  const ok = live;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1 text-[11px] font-medium ${
        ok ? "text-teal" : "text-risk"
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-teal" : "bg-risk"}`} />
      {ok ? "Network registries live" : "Node unreachable now"}
    </span>
  );
}
