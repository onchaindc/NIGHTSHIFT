import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@x402/evm", "@x402/fetch", "@x402/core", "@virtuals-protocol/acp-node-v2"],
  async redirects() {
    return [
      // The pre-pivot console is retired but its URLs still circulate. Send each
      // one to the closest page of the current product instead of a second app.
      // (/overview is a real destination again — the Overview page — so its old
      // redirect to the miner catalog is gone.)
      { source: "/console", destination: "/miners", permanent: false },
      { source: "/operations", destination: "/miners", permanent: false },
      { source: "/approvals", destination: "/miners", permanent: false },
      { source: "/agents", destination: "/miners", permanent: false },
      { source: "/nightshift", destination: "/", permanent: false },
      { source: "/watch", destination: "/signals", permanent: false },
      { source: "/history", destination: "/activity", permanent: false },
      // The pre-pivot task pages retired; keep every old task link working by
      // preserving the id — /tasks/:id lands on the same record in Activity.
      { source: "/tasks/:id", destination: "/activity/:id", permanent: false },
      { source: "/settings", destination: "/developers", permanent: false },
      // The tab says Wallet; keep the old-ish path working for links and bookmarks.
      { source: "/wallet", destination: "/funds", permanent: false },
      // Counterparty intelligence became the first Mind; keep old links working.
      { source: "/counterparty", destination: "/minds/counterparty", permanent: false },
    ];
  },
};

export default nextConfig;
