import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@x402/evm", "@x402/fetch", "@x402/core"],
  async redirects() {
    return [
      // Legacy entry points that used to land on the workspace overview.
      // They now route into the console; / itself is the product landing.
      { source: "/overview", destination: "/console", permanent: true },
    ];
  },
};

export default nextConfig;
